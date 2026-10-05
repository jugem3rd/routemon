-- Routemon Agent(HTTPS long-poll transport)。実機(RTX830)で検証済み。
-- 正式仕様: docs/core/agent-protocol.md
-- WebGUI local socket relayのロジックは、raw TCP版のPoCから流用し、
-- Backendとの通信のみ rt.httprequest() による sync へ置き換えている。
--
-- 実機検証で判明した制約への対応:
-- - Cloudflare Workers/Tunnel系エッジには接続できない(TLS handshake_failure)
--   ため、Backendは実在の信頼された証明書を使うLAN直結/通常CDN配下等の
--   HTTPSエンドポイントにすること
-- - method='POST'にはcontent_typeが必須、content_type指定時はpost_text/
--   post_fileのいずれかも必須(bodyの無いPOSTは不可)。送るframeが無い時は
--   HEARTBEAT frameを送る
-- - post_fileは内蔵フラッシュ(RTFS)への一時ファイル書き込みが必要で、遅い上に
--   フラッシュGCや書き込み失敗を招くため使わない(§22)。post_textが拒否する
--   バイト(0-8,11,12,14-31,127、実測)はtext_escapeで2バイトに置き換える
-- - レスポンスbodyはNULバイト(0x00)で切り捨てられるため、Backend→Agent方向は
--   COBSでエンコードされている
--
-- 動作パターン(§22): 1回のsync(POST)でAgent→Backendのframe送信と
-- Backend→Agentのframe受信を同時に行う(TLSハンドシェイクを1往復1回にする)。
-- streamが無い間はBackend側でIDLE_WAIT秒までlong-pollさせ、streamがある間は
-- 待たせずに即時往復する。

local VERSION = '0.3.0'
local BASE = 'https://example.invalid'
local DEVICE_TOKEN = 'routemon-poc-device-token'

-- Agent A/B update PoC(Issue #7): Bootstrap / Supervisor(agent/update/routemon_bootstrap.lua)
-- 配下で動く場合は、接続先とtokenをdevice configから読み、最初の認証済みsync成功を
-- health fileでSupervisorへ知らせる。device configが無ければ上の値を使う。
local HEALTH_FILE = '/routemon_health.dat'
-- Supervisor(#35)と共有するfile。Agentはstateを読むだけ、更新要求は書くだけ。
local STATE_FILE = '/routemon_state.dat'
local UPDATE_REQUEST_FILE = '/routemon_update.req'
local conf_chunk = loadfile('/routemon_device.conf')
if conf_chunk then
    local conf = conf_chunk()
    BASE = conf.gateway
    DEVICE_TOKEN = conf.token
end

-- 接続先の一覧(#147)。GATEWAY_ENDPOINTSで更新され、Supervisorも同じfileを読む。
-- 先頭が現在の接続先で、2つ目以降は将来のfailover用。fileが無ければdevice configのgatewayを使う。
-- device config(token入り)は書き換えない。
local ENDPOINTS_FILE = '/routemon_gateways.dat'
local ENDPOINTS_TMP = '/routemon_gateways.tmp'
local PREV_FILE = '/routemon_gateways.prev'
local PREV_TMP = '/routemon_gateways.prev.tmp'
local MAX_ENDPOINT_LENGTH = 200
local MAX_ENDPOINTS = 4
-- 切り替えた後、1度も成功しないまま連続でこの回数失敗したら、元の接続先へ戻す
local SWITCH_REVERT_FAILURES = 6
-- 確定しないまま、この回数までAgentが起動したら、元の接続先へ戻す
local SWITCH_REVERT_STARTS = 3

local function valid_endpoint(url)
    if type(url) ~= 'string' or #url > MAX_ENDPOINT_LENGTH then
        return false
    end
    if string.sub(url, -1) == '/' then
        return false
    end
    return string.match(url, '^https?://[%w%.%-_%[%]:]+[%w%./_~%-]*$') ~= nil
end

local function valid_list(list)
    if type(list) ~= 'table' or #list == 0 or #list > MAX_ENDPOINTS then
        return false
    end
    for i = 1, #list do
        if not valid_endpoint(list[i]) then
            return false
        end
    end
    return true
end

local function load_endpoints()
    local chunk = loadfile(ENDPOINTS_FILE)
    if not chunk then
        return nil
    end
    local ok, list = pcall(chunk)
    if ok and valid_list(list) then
        return list
    end
    return nil
end

local endpoints = { BASE }
do
    local saved = load_endpoints()
    if saved then
        endpoints = saved
        BASE = saved[1]
    end
end

-- 切り替えた直後(まだ1度も成功していない)の状態: { previous = 元の接続先の一覧, failures = 失敗回数 }。
-- メモリだけに置くと、Agentが落ちて再起動されたときに元へ戻れなくなる(実機で確認)ため、
-- 元の一覧と、確定しないまま起動した回数をPREV_FILEにも残す。
-- 最初のsync成功で確定(PREV_FILEを消す)し、失敗が続くか、確定しないまま再起動を繰り返したら、
-- 元の接続先へ戻す。
local pending_switch = nil

local function same_endpoints(a, b)
    if #a ~= #b then
        return false
    end
    for i = 1, #a do
        if a[i] ~= b[i] then
            return false
        end
    end
    return true
end

-- 一時fileへ書いてからrenameで置き換える。
local function write_file_atomic(path, tmp, body)
    local f = io.open(tmp, 'w')
    if not f then
        return false
    end
    f:write(body)
    f:close()
    os.remove(path)
    return os.rename(tmp, path) and true or false
end

local function quote_list(list)
    local parts = {}
    for i = 1, #list do
        parts[#parts + 1] = string.format('%q', list[i])
    end
    return '{' .. table.concat(parts, ',') .. '}'
end

-- 接続先一覧をfileへ保存する(Supervisorも読む)。
local function save_endpoints(list)
    return write_file_atomic(ENDPOINTS_FILE, ENDPOINTS_TMP, 'return ' .. quote_list(list))
end

local function save_prev(list, starts)
    return write_file_atomic(
        PREV_FILE,
        PREV_TMP,
        'return {list=' .. quote_list(list) .. ',starts=' .. tostring(starts) .. '}'
    )
end

local function load_prev()
    local chunk = loadfile(PREV_FILE)
    if not chunk then
        return nil
    end
    local ok, t = pcall(chunk)
    if not ok or type(t) ~= 'table' or not valid_list(t.list) then
        return nil
    end
    return { list = t.list, starts = tonumber(tostring(t.starts)) or 0 }
end

-- 元の接続先へ戻す。
local function revert_endpoints(previous_list, reason)
    pending_switch = nil
    endpoints = previous_list
    BASE = previous_list[1]
    save_endpoints(previous_list)
    os.remove(PREV_FILE)
    rt.syslog('info', 'routemon agent: gateway endpoints reverted (' .. reason .. ')')
end

-- 起動時: 前回の切り替えが確定していなければ、起動の回数を数え、続くようなら元へ戻す
do
    local prev = load_prev()
    if prev then
        local starts = prev.starts + 1
        if starts >= SWITCH_REVERT_STARTS then
            revert_endpoints(prev.list, 'unconfirmed after restarts')
        else
            save_prev(prev.list, starts)
            pending_switch = { previous = prev.list, failures = 0, skip = 0 }
        end
    end
end

-- GATEWAY_ENDPOINTS(#147): payload = endpoint URL(LF区切り)。不正な行があれば全体を捨てる。
local function apply_endpoints(payload)
    local list = {}
    for line in string.gmatch(payload, '[^' .. string.char(10) .. ']+') do
        local url = string.gsub(string.gsub(line, '^%s+', ''), '%s+$', '')
        if url ~= '' then
            if not valid_endpoint(url) then
                rt.syslog('info', 'routemon agent: gateway endpoints rejected')
                return
            end
            list[#list + 1] = url
        end
    end
    if #list == 0 or #list > MAX_ENDPOINTS or same_endpoints(list, endpoints) then
        return
    end
    local previous_list = endpoints
    local switching = list[1] ~= BASE
    -- 戻るための情報を先に残す(途中で落ちても、元へ戻れる)
    if switching and not pending_switch and not save_prev(previous_list, 0) then
        rt.syslog('info', 'routemon agent: gateway endpoints save failed')
        return
    end
    if not save_endpoints(list) then
        rt.syslog('info', 'routemon agent: gateway endpoints save failed')
        return
    end
    endpoints = list
    BASE = list[1]
    if switching and not pending_switch then
        -- このframeは、古い接続先でのsyncの応答として届いている。その成功は、新しい接続先の
        -- 確認にならないため、数えない(skip)
        pending_switch = { previous = previous_list, failures = 0, skip = 1 }
    end
    rt.syslog('info', 'routemon agent: gateway endpoints updated')
end

-- 切り替えた接続先へつながらない場合に、元の接続先へ戻す(誤った設定で遠隔管理できなくなるのを防ぐ)
local function note_sync_failure()
    if not pending_switch then
        return
    end
    pending_switch.failures = pending_switch.failures + 1
    if pending_switch.failures >= SWITCH_REVERT_FAILURES then
        revert_endpoints(pending_switch.previous, 'sync failed')
    end
end
local WEBGUI_IP = '192.168.100.1'
local WEBGUI_PORT = 80

local IDLE_TIMEOUT = 5
local IDLE_WAIT = 20
-- SYSLOG(Issue #26): 監視専用task(agent/routemon_syslog_watcher.lua)から回収する
local SYSLOG_PORT = 4500
local SYSLOG_LIVE_WAIT = 1
local BASE_BACKOFF = 1
local MAX_BACKOFF = 30
local RECV_SIZE = 8192

-- ponytail: math.floor が無い環境のため剰余の引き算で桁を落とす。
local function u16(n)
    local lo = n % 256
    local hi = (n - lo) / 256
    return string.char(hi, lo)
end

local function u32(n)
    local b4 = n % 256
    local r = (n - b4) / 256
    local b3 = r % 256
    r = (r - b3) / 256
    local b2 = r % 256
    r = (r - b2) / 256
    local b1 = r % 256
    return string.char(b1, b2, b3, b4)
end

local function encode(mtype, stream_id, payload)
    payload = payload or ''
    return string.char(1, mtype) .. u16(stream_id) .. u32(#payload) .. payload
end

local HEARTBEAT = encode(0x03, 0, '')

-- post_textが拒否するバイトと、エスケープ文字の0xFF自身を 0xFF + (b XOR 0x40) の
-- 2バイトへ置き換える(backend/https_tunnel_gateway.pyのtext_unescapeで復元)。
-- 0xFFはUTF-8テキストに現れず、WebGUIのHTML/JS/CSSは実測で約2%しか増えない。
-- gsubはC側で処理されるため、Luaで1バイトずつ回すより大幅に速い。
local ESC = string.char(255)
local UNSAFE = '[%z' .. string.char(1) .. '-' .. string.char(8, 11, 12, 14) .. '-' .. string.char(31, 127, 255) .. ']'
local ESC_MAP = {}
for b = 0, 255 do
    local x = b + 64
    if b % 128 >= 64 then
        x = b - 64
    end
    ESC_MAP[string.char(b)] = ESC .. string.char(x)
end

local function text_escape(data)
    return (string.gsub(data, UNSAFE, ESC_MAP))
end

local ZERO = string.char(0)

local function cobs_decode(data)
    local out = {}
    local i = 1
    local n = #data
    while i <= n do
        local code = string.byte(data, i)
        i = i + 1
        if code > 1 then
            table.insert(out, string.sub(data, i, i + code - 2))
            i = i + code - 1
        end
        if code < 255 and i <= n then
            table.insert(out, ZERO)
        end
    end
    return table.concat(out)
end

-- Phase 3 8.3: send()が一度でpayload全体を送れない場合に残りを送り切る。
local function send_all(sock, data)
    local start = 1
    local len = #data
    while start <= len do
        local sent, err, last = sock:send(data, start)
        if sent then
            start = sent + 1
        elseif last and last >= start then
            start = last + 1
        else
            return false, err
        end
    end
    return true
end

local function sleep(seconds)
    rt.socket.select({}, {}, seconds)
end

local pending = {}        -- 次のsyncで送るframe(COMMAND_RESPONSE等)
local syslog_live = false -- Live Logs中はflush周期を短くする
local streams = {}        -- stream_id -> webgui socket
local sid_of = {}         -- webgui socket -> stream_id
local last_activity = {}  -- stream_id -> os.time()

-- CONFIG Apply(#62)。CONFIG本文はLuaの文字列へ変換せず、受信したraw byteを
-- そのままwbでstagingへ書く。operation_idから作るpath以外の入力をpathへ入れない。
local APPLY_BEGIN = 0x44
local APPLY_CHUNK = 0x45
local APPLY_END = 0x46
local APPLY_ACTIVATE = 0x47
local APPLY_RESULT = 0x48
local APPLY_ABORT = 0x49

local APPLY_STATUS_READY = 0x01
local APPLY_STATUS_CHUNK_ACK = 0x02
local APPLY_STATUS_STAGED = 0x03
local APPLY_STATUS_LOADED = 0x04
local APPLY_STATUS_WRITE_FAILED = 0x05
local APPLY_STATUS_LOAD_FAILED = 0x06
local APPLY_STATUS_INVALID = 0x08

local APPLY_ERROR_NONE = 0x00
local APPLY_ERROR_INVALID_PAYLOAD = 0x01
local APPLY_ERROR_INVALID_SEQUENCE = 0x02
local APPLY_ERROR_CHUNK_TOO_LARGE = 0x03
local APPLY_ERROR_BYTE_COUNT_MISMATCH = 0x04
local APPLY_ERROR_CHUNK_COUNT_MISMATCH = 0x05
local APPLY_ERROR_FILE_OPEN_FAILED = 0x07
local APPLY_ERROR_FILE_WRITE_FAILED = 0x08
local APPLY_ERROR_FILE_CLOSE_FAILED = 0x09
local APPLY_ERROR_LOAD_FAILED = 0x0a
local APPLY_ERROR_NOT_STAGED = 0x0b
local APPLY_ERROR_ALREADY_ACTIVATED = 0x0c

local APPLY_NONE_SEQ = 4294967295
local APPLY_BEGIN_BYTES = 54
local APPLY_END_BYTES = 8
local APPLY_MAX_CHUNK_PAYLOAD = 32768
local APPLY_MAX_CHUNK_BYTES = 32764
local APPLY_PATH_PREFIX = '/routemon_config_apply_'
local APPLY_PATH_SUFFIX = '.tmp'
local HEX = '0123456789abcdef'

-- BEGINからENDまで生存するApply state。fileはsyncをまたいで同じものを使う。
local apply_state = nil

local function read_u16(data, pos)
    local b1, b2 = string.byte(data, pos, pos + 1)
    if not b2 then
        return nil
    end
    return b1 * 256 + b2
end

local function read_u32(data, pos)
    local b1, b2, b3, b4 = string.byte(data, pos, pos + 3)
    if not b4 then
        return nil
    end
    return b1 * 16777216 + b2 * 65536 + b3 * 256 + b4
end

local function operation_path(operation_id)
    local chars = {}
    for i = 1, #operation_id do
        local b = string.byte(operation_id, i)
        local lo = b % 16
        local hi = (b - lo) / 16
        chars[#chars + 1] = string.sub(HEX, hi + 1, hi + 1)
        chars[#chars + 1] = string.sub(HEX, lo + 1, lo + 1)
    end
    return APPLY_PATH_PREFIX .. table.concat(chars) .. APPLY_PATH_SUFFIX
end

local function queue_apply_result(sid, status, seq, error_code)
    local encoded_seq = seq
    if encoded_seq == nil then
        encoded_seq = APPLY_NONE_SEQ
    end
    local payload = string.char(status) .. u32(encoded_seq) .. string.char(error_code)
    table.insert(pending, encode(APPLY_RESULT, sid, payload))
end

local function close_apply_file(state)
    if state and state.file then
        pcall(function()
            state.file:close()
        end)
        state.file = nil
    end
end

local function discard_apply()
    local state = apply_state
    if not state then
        return
    end
    close_apply_file(state)
    if state.path then
        pcall(function()
            os.remove(state.path)
        end)
    end
    apply_state = nil
end

local function fail_apply(sid, status, error_code)
    discard_apply()
    queue_apply_result(sid, status, nil, error_code)
end

local function decode_apply_begin(payload)
    if #payload ~= APPLY_BEGIN_BYTES then
        return nil, APPLY_ERROR_INVALID_PAYLOAD
    end
    local total_bytes = read_u32(payload, 17)
    local chunk_bytes = read_u16(payload, 21)
    if not total_bytes or not chunk_bytes then
        return nil, APPLY_ERROR_INVALID_PAYLOAD
    end
    if total_bytes == 0 or chunk_bytes == 0 or chunk_bytes > APPLY_MAX_CHUNK_BYTES then
        return nil, APPLY_ERROR_INVALID_PAYLOAD
    end
    return {
        operation_id = string.sub(payload, 1, 16),
        total_bytes = total_bytes,
        chunk_bytes = chunk_bytes,
    }
end

local function begin_apply(sid, begin)
    if apply_state then
        if apply_state.phase == 'activated' then
            queue_apply_result(sid, APPLY_STATUS_INVALID, nil, APPLY_ERROR_ALREADY_ACTIVATED)
            return
        end
        -- load前のstateはGatewayの再初期化(同じoperation_id)でも、Gatewayや
        -- Serverの再起動後に来る別operation_idでも、古いpartial fileを捨てて
        -- BEGINからやり直す。ACTIVATE後だけは上で拒否する。
        discard_apply()
    end

    local path = operation_path(begin.operation_id)
    local file = io.open(path, 'wb')
    if not file then
        queue_apply_result(sid, APPLY_STATUS_INVALID, nil, APPLY_ERROR_FILE_OPEN_FAILED)
        return
    end
    apply_state = {
        stream_id = sid,
        operation_id = begin.operation_id,
        total_bytes = begin.total_bytes,
        chunk_bytes = begin.chunk_bytes,
        path = path,
        file = file,
        received_bytes = 0,
        next_seq = 0,
        phase = 'receiving',
    }
    queue_apply_result(sid, APPLY_STATUS_READY, nil, APPLY_ERROR_NONE)
end

local function handle_apply_chunk(sid, payload)
    local state = apply_state
    if #payload < 5 then
        fail_apply(sid, APPLY_STATUS_INVALID, APPLY_ERROR_INVALID_PAYLOAD)
        return
    end
    if #payload > APPLY_MAX_CHUNK_PAYLOAD then
        fail_apply(sid, APPLY_STATUS_INVALID, APPLY_ERROR_CHUNK_TOO_LARGE)
        return
    end
    if state.phase ~= 'receiving' or not state.file then
        fail_apply(sid, APPLY_STATUS_INVALID, APPLY_ERROR_NOT_STAGED)
        return
    end

    local seq = read_u32(payload, 1)
    local bytes = string.sub(payload, 5)
    if not seq or #bytes == 0 then
        fail_apply(sid, APPLY_STATUS_INVALID, APPLY_ERROR_INVALID_PAYLOAD)
        return
    end
    if seq ~= state.next_seq then
        fail_apply(sid, APPLY_STATUS_INVALID, APPLY_ERROR_INVALID_SEQUENCE)
        return
    end
    if #bytes > state.chunk_bytes then
        fail_apply(sid, APPLY_STATUS_INVALID, APPLY_ERROR_CHUNK_TOO_LARGE)
        return
    end
    if state.received_bytes + #bytes > state.total_bytes then
        fail_apply(sid, APPLY_STATUS_INVALID, APPLY_ERROR_BYTE_COUNT_MISMATCH)
        return
    end

    local ok, result = pcall(function()
        return state.file:write(bytes)
    end)
    if not ok or not result then
        fail_apply(sid, APPLY_STATUS_WRITE_FAILED, APPLY_ERROR_FILE_WRITE_FAILED)
        return
    end
    state.received_bytes = state.received_bytes + #bytes
    state.next_seq = state.next_seq + 1
    queue_apply_result(sid, APPLY_STATUS_CHUNK_ACK, seq, APPLY_ERROR_NONE)
end

local function handle_apply_end(sid, payload)
    local state = apply_state
    if #payload ~= APPLY_END_BYTES then
        fail_apply(sid, APPLY_STATUS_INVALID, APPLY_ERROR_INVALID_PAYLOAD)
        return
    end
    if state.phase ~= 'receiving' or not state.file then
        fail_apply(sid, APPLY_STATUS_INVALID, APPLY_ERROR_NOT_STAGED)
        return
    end

    local total_bytes = read_u32(payload, 1)
    local chunk_count = read_u32(payload, 5)
    if not total_bytes or not chunk_count then
        fail_apply(sid, APPLY_STATUS_INVALID, APPLY_ERROR_INVALID_PAYLOAD)
        return
    end
    if state.received_bytes ~= state.total_bytes or total_bytes ~= state.total_bytes then
        fail_apply(sid, APPLY_STATUS_INVALID, APPLY_ERROR_BYTE_COUNT_MISMATCH)
        return
    end
    if chunk_count ~= state.next_seq then
        fail_apply(sid, APPLY_STATUS_INVALID, APPLY_ERROR_CHUNK_COUNT_MISMATCH)
        return
    end

    local file = state.file
    local ok, closed = pcall(function()
        return file:close()
    end)
    state.file = nil
    if not ok or not closed then
        discard_apply()
        queue_apply_result(sid, APPLY_STATUS_WRITE_FAILED, nil, APPLY_ERROR_FILE_CLOSE_FAILED)
        return
    end
    state.phase = 'staged'
    queue_apply_result(sid, APPLY_STATUS_STAGED, nil, APPLY_ERROR_NONE)
end

local function handle_apply_activate(sid, payload)
    local state = apply_state
    if #payload ~= 0 then
        fail_apply(sid, APPLY_STATUS_INVALID, APPLY_ERROR_INVALID_PAYLOAD)
        return
    end
    if state.phase == 'activated' then
        queue_apply_result(sid, APPLY_STATUS_INVALID, nil, APPLY_ERROR_ALREADY_ACTIVATED)
        return
    end
    if state.phase ~= 'staged' or not state.path then
        fail_apply(sid, APPLY_STATUS_INVALID, APPLY_ERROR_NOT_STAGED)
        return
    end

    -- ACTIVATEは一方向の境界。先にphaseを変えて、同じframeが再度届いても
    -- loadを二重実行しない。rt.commandの出力は変数へ保持せず、frameにも載せない。
    state.phase = 'activated'
    local command = 'load file ' .. state.path .. ' silent'
    local call_ok, command_ok = pcall(function()
        local ok = rt.command(command, 'off')
        return ok
    end)
    pcall(function()
        os.remove(state.path)
    end)
    if call_ok and command_ok then
        queue_apply_result(sid, APPLY_STATUS_LOADED, nil, APPLY_ERROR_NONE)
        return
    end
    discard_apply()
    queue_apply_result(sid, APPLY_STATUS_LOAD_FAILED, nil, APPLY_ERROR_LOAD_FAILED)
end

local function handle_apply_abort(sid, payload)
    local state = apply_state
    if #payload ~= 0 then
        fail_apply(sid, APPLY_STATUS_INVALID, APPLY_ERROR_INVALID_PAYLOAD)
        return
    end
    if state.phase == 'activated' then
        queue_apply_result(sid, APPLY_STATUS_INVALID, nil, APPLY_ERROR_ALREADY_ACTIVATED)
        return
    end
    -- ABORTはGateway側が応答を待たない一方向のcleanup。stagingを削除し、
    -- 結果frameは返さない(次のApplyをすぐ開始できるようにする)。
    discard_apply()
end

local function process_apply_frame(mtype, sid, payload)
    if mtype == APPLY_BEGIN then
        local begin, error_code = decode_apply_begin(payload)
        if not begin then
            if apply_state and apply_state.stream_id == sid then
                fail_apply(sid, APPLY_STATUS_INVALID, error_code)
            end
            return
        end
        if apply_state and apply_state.phase == 'activated' then
            queue_apply_result(sid, APPLY_STATUS_INVALID, nil, APPLY_ERROR_ALREADY_ACTIVATED)
            return
        end
        begin_apply(sid, begin)
        return
    end

    if not apply_state or apply_state.stream_id ~= sid then
        -- Gatewayの再初期化前に届いた古いstreamは、状態を変更せず捨てる。
        return
    end
    if mtype == APPLY_CHUNK then
        handle_apply_chunk(sid, payload)
    elseif mtype == APPLY_END then
        handle_apply_end(sid, payload)
    elseif mtype == APPLY_ACTIVATE then
        handle_apply_activate(sid, payload)
    elseif mtype == APPLY_ABORT then
        handle_apply_abort(sid, payload)
    end
end

local function close_stream_local(sid, sock, reason)
    print('stream ' .. sid .. ' closed: ' .. tostring(reason))
    sock:close()
    streams[sid] = nil
    sid_of[sock] = nil
    last_activity[sid] = nil
end

-- 送信時だけtimeoutを設け、受信はselectで読めると分かったソケットからtimeout 0
-- で即座に読む。0.2秒timeoutのままだと、読めるソケットが複数あると1本ごとに
-- 最大0.2秒ずつ直列に待たされる(§22)。
local function send_to_gui(sock, data)
    sock:settimeout(5)
    send_all(sock, data)
    sock:settimeout(0)
end

-- Supervisorのstate(#35)。slotと直前のrollback理由をServerへ報告するために読む。
local function read_state()
    local chunk = loadfile(STATE_FILE)
    if not chunk then
        return {}
    end
    local ok, st = pcall(chunk)
    if not ok or type(st) ~= 'table' then
        return {}
    end
    return st
end

-- AGENT_STATUS(#35): version / slot / 直前のrollback理由
local function queue_agent_status()
    local st = read_state()
    -- 起動直後はcandidateがactiveへ昇格する前なので、candidateを優先して報告する
    local lines = VERSION .. string.char(10) .. tostring(st.candidate or st.active or '')
    if st.last_rollback then
        lines = lines .. string.char(10) .. 'rollback:' .. st.last_rollback
    end
    -- Supervisorのversionと、Supervisor自身の更新を直前に戻した理由(#159)
    if st.supervisor_version then
        lines = lines .. string.char(10) .. 'supervisor:' .. st.supervisor_version
    end
    if st.supervisor_rollback then
        lines = lines .. string.char(10) .. 'supervisor_rollback:' .. st.supervisor_rollback
    end
    table.insert(pending, encode(0x43, 0, lines))
end

-- 更新要求をSupervisorへ渡す(#35)。downloadと検証はSupervisorが行う。
local function request_update(version)
    if not version or version == '' or version == VERSION then
        return
    end
    local f = io.open(UPDATE_REQUEST_FILE, 'w')
    if not f then
        return
    end
    f:write(version)
    f:close()
    rt.syslog('info', 'routemon agent: update requested ' .. version)
end

-- CONFIG snapshot(#6)。Agentは本文を解釈せず、show configの出力をそのまま載せる。
-- payload = reason .. LF .. CONFIG本文
-- RTX830でload直後の一時的なshow config失敗を実測するため、apply_verifyだけ再試行する。
-- 待機合計18秒は実機測定前の暫定値。
local CONFIG_VERIFY_RETRY_DELAYS = {1, 2, 5, 10}
local function queue_config_snapshot(reason)
    local attempts = 1
    local ok, out = rt.command('show config')
    if reason == 'apply_verify' then
        for i = 1, #CONFIG_VERIFY_RETRY_DELAYS do
            if ok and out then
                break
            end
            sleep(CONFIG_VERIFY_RETRY_DELAYS[i])
            attempts = attempts + 1
            ok, out = rt.command('show config')
        end
    end
    if not ok or not out then
        if reason == 'apply_verify' then
            rt.syslog('info', 'routemon agent: apply_verify show config failed after ' .. tostring(attempts) .. ' attempts')
        else
            rt.syslog('info', 'routemon agent: show config failed')
        end
        return
    end
    if reason == 'apply_verify' then
        rt.syslog('info', 'routemon agent: apply_verify show config succeeded on attempt ' .. tostring(attempts) .. ' of 5')
    end
    table.insert(pending, encode(0x40, 0, reason .. string.char(10) .. out))
end

-- syncで受け取った1frameを処理し、必要ならlocal WebGUI socketを開く/中継/閉じる。
local function process_inbound_frame(mtype, sid, payload)
    if mtype == 0x03 then -- HEARTBEAT: 何もしない(sync自体が生存確認になる)
    elseif mtype == 0x33 then -- SYSLOG_LIVE: Live modeの切り替え
        syslog_live = string.byte(payload, 1) == 1
    elseif mtype == 0x42 then -- UPDATE_AVAILABLE: Supervisorへ更新要求を置く
        request_update(payload)
    elseif mtype == 0x4A then -- GATEWAY_ENDPOINTS: 接続先一覧の更新(#147)
        apply_endpoints(payload)
    elseif mtype == 0x41 then -- CONFIG_REQUEST: CONFIG snapshotを返す
        queue_config_snapshot(payload)
    elseif mtype >= APPLY_BEGIN and mtype <= APPLY_ABORT then
        process_apply_frame(mtype, sid, payload)
    elseif mtype == 0x10 then -- COMMAND_REQUEST: rt.command()を実行して結果を返す
        local ok, output = rt.command(payload)
        local flag = 0
        if ok then
            flag = 1
        end
        table.insert(pending, encode(0x11, sid, string.char(flag) .. tostring(output)))
    elseif mtype == 0x20 then -- STREAM_OPEN
        local gui = rt.socket.tcp()
        gui:settimeout(5)
        if gui:connect(WEBGUI_IP, WEBGUI_PORT) then
            send_to_gui(gui, payload)
            streams[sid] = gui
            sid_of[gui] = sid
            last_activity[sid] = os.time()
            print('stream ' .. sid .. ' open')
        else
            gui:close()
        end
    elseif mtype == 0x21 then -- STREAM_DATA
        local s = streams[sid]
        if s then
            send_to_gui(s, payload)
            last_activity[sid] = os.time()
        end
    elseif mtype == 0x22 then -- STREAM_CLOSE
        local s = streams[sid]
        if s then
            s:close()
            streams[sid] = nil
            sid_of[s] = nil
            last_activity[sid] = nil
        end
    end
end

local function parse_frames(data)
    local i = 1
    local n = #data
    while i <= n do
        local mtype = string.byte(data, i + 1)
        local b3, b4 = string.byte(data, i + 2, i + 3)
        local sid = b3 * 256 + b4
        local l1, l2, l3, l4 = string.byte(data, i + 4, i + 7)
        local length = l1 * 16777216 + l2 * 65536 + l3 * 256 + l4
        local payload = string.sub(data, i + 8, i + 8 + length - 1)
        process_inbound_frame(mtype, sid, payload)
        i = i + 8 + length
    end
end

-- 監視task(agent/routemon_syslog_watcher.lua)への接続を保持し、届いている行を
-- 待たずに読む。接続が切れていれば張り直す。
local syslog_sock = nil
local syslog_live_sent = nil

-- watcherへLive modeを伝える(#79)。watcherはLive中だけwatch窓を短くする。
-- 通知できなくても収集自体は続くので、失敗しても握りつぶす。
local function notify_watcher_live()
    if not syslog_sock or syslog_live_sent == syslog_live then
        return
    end
    local line = 'L0'
    if syslog_live then
        line = 'L1'
    end
    if syslog_sock:send(line .. string.char(10)) then
        syslog_live_sent = syslog_live
    end
end

local function collect_syslog()
    if not syslog_sock then
        local sock = rt.socket.tcp()
        sock:settimeout(1)
        if not sock:connect('127.0.0.1', SYSLOG_PORT) then
            sock:close()
            return nil
        end
        sock:settimeout(0)
        syslog_sock = sock
        syslog_live_sent = nil
    end
    notify_watcher_live()
    local data, rerr, partial = syslog_sock:receive(RECV_SIZE)
    local lines = data or partial
    if not data and rerr ~= 'timeout' then
        syslog_sock:close()
        syslog_sock = nil
        syslog_live_sent = nil
    end
    if lines and #lines > 0 then
        return encode(0x32, 0, lines)
    end
    return nil
end

-- 送信するframe列を送り、同じレスポンスでBackendからのframe列を受け取る。
local function sync(up, wait)
    if up == '' then
        up = HEARTBEAT
    end
    local ok, r = pcall(function()
        return rt.httprequest({
            url = BASE .. '/v1/tunnel/sync/' .. wait,
            method = 'POST',
            auth_type = 'bearer',
            auth_token = DEVICE_TOKEN,
            content_type = 'application/octet-stream',
            post_text = text_escape(up),
            timeout = wait + 10,
        })
    end)
    if not ok then
        return false, 'sync crashed: ' .. tostring(r)
    end
    if not r.rtn1 then
        return false, 'sync failed: ' .. tostring(r.err)
    end
    -- HTTP statusを確認する(docs/core/agent-protocol.md §14 Open item 1。401等を成功扱いにしない)
    if tonumber(tostring(r.code)) ~= 200 then
        return false, 'sync http ' .. tostring(r.code)
    end
    if r.body and #r.body > 0 then
        parse_frames(cobs_decode(r.body))
    end
    return true
end

local function collect_streams_once()
    local now = os.time()
    -- idle timeoutでローカルソケットを閉じる場合もBackendへSTREAM_CLOSEを送る
    -- (送らないとBackend側でstreamが残り続ける、§21.3)。
    local outbound = {}
    for sid, sock in pairs(streams) do
        if now - (last_activity[sid] or now) > IDLE_TIMEOUT then
            table.insert(outbound, encode(0x22, sid, ''))
            close_stream_local(sid, sock, 'idle timeout')
        end
    end

    local waitset = {}
    for _, sock in pairs(streams) do
        table.insert(waitset, sock)
    end
    if #waitset == 0 then
        if #outbound > 0 then
            return outbound
        end
        return nil
    end

    local readable = rt.socket.select(waitset, {}, 1 / 10)
    if readable then
        for _, sock in ipairs(readable) do
            local sid = sid_of[sock]
            local chunk, rerr, partial = sock:receive(RECV_SIZE)
            local data = chunk or partial or ''
            if #data > 0 then
                table.insert(outbound, encode(0x21, sid, data))
                last_activity[sid] = os.time()
            end
            if not chunk and rerr ~= 'timeout' then
                table.insert(outbound, encode(0x22, sid, ''))
                close_stream_local(sid, sock, rerr)
            end
        end
    end
    return outbound
end

-- 次のsyncで送るframe列を集める。全streamが閉じた・データの後に無音が続いた・
-- 何も読めないまま約1秒経った(新規リクエストを取り込むため一旦syncへ戻る)・
-- MAX_BATCH_BYTESに達した、のいずれかで返す。MAX_BATCH_BYTESは1回のsyncの
-- bodyを抑えてメモリ確保を小さく保つための上限(§21.6)。
local COLLECT_DEADLINE = 5
local QUIET_LIMIT = 2
local EMPTY_LIMIT = 10
local MAX_BATCH_BYTES = 65536

local function collect()
    local deadline = os.time() + COLLECT_DEADLINE
    local out = {}
    for i = 1, #pending do
        out[i] = pending[i]
    end
    pending = {}
    local bytes = 0
    local quiet = 0
    local empty = 0
    while os.time() < deadline do
        local batch = collect_streams_once()
        if batch == nil then
            break
        end
        if #batch > 0 then
            for _, frame in ipairs(batch) do
                out[#out + 1] = frame
                bytes = bytes + #frame
            end
            quiet = 0
            if bytes >= MAX_BATCH_BYTES then
                break
            end
        elseif #out > 0 then
            quiet = quiet + 1
            if quiet >= QUIET_LIMIT then
                break
            end
        else
            empty = empty + 1
            if empty >= EMPTY_LIMIT then
                break
            end
        end
    end
    return table.concat(out)
end

print('=== https_tunnel_agent start ' .. VERSION .. ' ===')
queue_agent_status()
queue_config_snapshot('agent_start')
local backoff = BASE_BACKOFF
local healthy = false
local up = ''
local first_sync = true
while true do
    local wait = IDLE_WAIT
    if first_sync then
        wait = 0
        first_sync = false
    elseif #up > 0 or next(streams) then
        wait = 0
    elseif syslog_live then
        wait = SYSLOG_LIVE_WAIT
    end
    local syslog_frame = collect_syslog()
    if syslog_frame then
        up = up .. syslog_frame
        wait = 0
    end
    local ok, err = sync(up, wait)
    if ok then
        -- 切り替えた接続先で最初のsyncが成功したら、切り替えを確定する
        if pending_switch then
            if pending_switch.skip > 0 then
                pending_switch.skip = pending_switch.skip - 1
            else
                pending_switch = nil
                os.remove(PREV_FILE)
            end
        end
        if not healthy then
            healthy = true
            local f = io.open(HEALTH_FILE, 'w')
            if f then
                f:write(VERSION)
                f:close()
            end
        end
        backoff = BASE_BACKOFF
        up = collect()
    else
        print('session error: ' .. tostring(err))
        note_sync_failure()
        backoff = backoff * 2
        if backoff > MAX_BACKOFF then
            backoff = MAX_BACKOFF
        end
        print('retrying in ' .. backoff .. 's')
        sleep(backoff)
    end
end
