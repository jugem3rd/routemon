-- agent/https_tunnel_agent.lua の text_escape / cobs_decode を参照実装と突き合わせる。
-- RTX830のLuaと同じ5.1系で実行する(パターンの%zが5.1の書き方のため):
--   luajit agent/https_tunnel_agent_test.lua
local src = assert(io.open('agent/https_tunnel_agent.lua')):read('*a')
local head = src:sub(1, src:find("print('=== https_tunnel_agent start", 1, true) - 1)
local text_escape, cobs_decode, process_inbound_frame, get_apply_state, reset_apply, queue_config_snapshot =
    assert(loadstring(head .. ' return text_escape, cobs_decode, process_inbound_frame, function() return pending, apply_state end, function() discard_apply(); pending = {} end, queue_config_snapshot'))()

-- post_textが拒否するバイト(実機で全256値を確認、§22)とエスケープ文字0xFF
local UNSAFE = {[127] = true, [255] = true}
for b = 0, 31 do
    if b ~= 9 and b ~= 10 and b ~= 13 then
        UNSAFE[b] = true
    end
end

-- backend/https_tunnel_gateway.pyのtext_unescapeと同じ処理
local function ref_unescape(data)
    return (data:gsub('\255(.)', function(c)
        local b = c:byte()
        return string.char(b % 128 >= 64 and b - 64 or b + 64)
    end))
end

-- backend/cobs.pyと同じアルゴリズム
local function ref_cobs_encode(data)
    local out, code, pending = {}, 1, {}
    local function flush()
        out[#out + 1] = string.char(code) .. table.concat(pending)
        code, pending = 1, {}
    end
    for i = 1, #data do
        local b = data:sub(i, i)
        if b == '\0' then
            flush()
        else
            pending[#pending + 1] = b
            code = code + 1
            if code == 255 then
                flush()
            end
        end
    end
    flush()
    return table.concat(out)
end

local function check(data)
    local esc = text_escape(data)
    for i = 1, #esc do
        local b = esc:byte(i)
        assert(b == 255 or not UNSAFE[b], 'unsafe byte ' .. b .. ' in escaped output')
    end
    assert(ref_unescape(esc) == data, 'escape roundtrip mismatch, len=' .. #data)
    assert(cobs_decode(ref_cobs_encode(data)) == data, 'cobs roundtrip mismatch, len=' .. #data)
end

local all = {}
for b = 0, 255 do
    all[#all + 1] = string.char(b)
end
check(table.concat(all))
for _, n in ipairs({0, 1, 253, 254, 255, 508, 509}) do
    check(string.rep('a', n))
    check(string.rep('a', n) .. '\0')
    check('\0' .. string.rep('\255', n))
end

math.randomseed(1)
for _ = 1, 500 do
    local zero_rate = math.random()
    local t = {}
    for i = 1, math.random(0, 3000) do
        t[i] = math.random() < zero_rate and '\0' or string.char(math.random(1, 255))
    end
    check(table.concat(t))
end

-- CONFIG Applyの受信state machineを実行する。実機のio/rtは使わず、
-- file handle・rt.commandをmemory stubへ差し替える。
local real_io = io
local real_os = os
local real_rt = _G.rt
local files = {}
local opens = {}
local commands = {}
local sleep_intervals = {}
local syslog_messages = {}
local fail_open = false
local fail_write = false
local fail_close = false

local function fake_open(path, mode)
    opens[#opens + 1] = {path = path, mode = mode}
    if fail_open then
        return nil
    end
    local entry = {path = path, data = '', closed = false}
    local file = {}
    function file:write(data)
        if fail_write then
            error('write failed')
        end
        entry.data = entry.data .. data
        return self
    end
    function file:close()
        entry.closed = true
        if fail_close then
            return nil
        end
        return true
    end
    entry.file = file
    files[path] = entry
    return file
end

_G.io = {open = fake_open}
_G.os = {
    remove = function(path)
        files[path] = nil
        return true
    end,
    time = real_os.time,
}
_G.rt = {
    socket = {
        select = function(_, _, seconds)
            sleep_intervals[#sleep_intervals + 1] = seconds
        end,
    },
    command = function(command)
        commands[#commands + 1] = command
        return true, 'load output must not be forwarded'
    end,
    syslog = function(_, message)
        syslog_messages[#syslog_messages + 1] = message
    end,
}

local function be16(n)
    local lo = n % 256
    local hi = (n - lo) / 256
    return string.char(hi, lo)
end

local function be32(n)
    local b4 = n % 256
    local r = (n - b4) / 256
    local b3 = r % 256
    r = (r - b3) / 256
    local b2 = r % 256
    r = (r - b2) / 256
    local b1 = r % 256
    return string.char(b1, b2, b3, b4)
end

local function begin_payload(operation_id, total_bytes, chunk_bytes)
    return operation_id .. be32(total_bytes) .. be16(chunk_bytes) .. string.rep('\0', 32)
end

local function frame_parts(frame)
    local b3, b4 = string.byte(frame, 3, 4)
    local l1, l2, l3, l4 = string.byte(frame, 5, 8)
    local length = l1 * 16777216 + l2 * 65536 + l3 * 256 + l4
    return string.byte(frame, 2), b3 * 256 + b4, string.sub(frame, 9, 8 + length)
end

local function clear_pending()
    local pending = get_apply_state()
    for i = #pending, 1, -1 do
        table.remove(pending, i)
    end
end

local function expect_result(status, seq, error_code)
    local pending = get_apply_state()
    assert(#pending == 1, 'expected one result frame')
    local mtype, sid, payload = frame_parts(pending[1])
    assert(mtype == 0x48, 'expected CONFIG_APPLY_RESULT')
    assert(sid == 7 or sid == 8 or sid == 9 or sid == 10 or sid == 11)
    assert(string.byte(payload, 1) == status, 'unexpected result status')
    local actual_seq = string.byte(payload, 2) * 16777216 + string.byte(payload, 3) * 65536 + string.byte(payload, 4) * 256 + string.byte(payload, 5)
    local expected_seq = seq
    if expected_seq == nil then
        expected_seq = 4294967295
    end
    assert(actual_seq == expected_seq, 'unexpected result seq')
    assert(string.byte(payload, 6) == error_code, 'unexpected result error')
end

local operation_id = string.rep('A', 16)
local begin = begin_payload(operation_id, 3, 3)
process_inbound_frame(0x44, 7, begin)
expect_result(0x01, nil, 0x00)
assert(#opens == 1 and opens[1].mode == 'wb')
clear_pending()

process_inbound_frame(0x45, 7, be32(0) .. 'abc')
expect_result(0x02, 0, 0x00)
local first_path = opens[1].path
assert(files[first_path].data == 'abc')
assert(#opens == 1, 'CHUNK must reuse the BEGIN file handle')
clear_pending()

process_inbound_frame(0x46, 7, be32(3) .. be32(1))
expect_result(0x03, nil, 0x00)
assert(files[first_path].closed)
clear_pending()

process_inbound_frame(0x47, 7, '')
expect_result(0x04, nil, 0x00)
assert(#commands == 1)
assert(commands[1]:find('load file ', 1, true))
assert(commands[1]:find(' silent', 1, true))
assert(not commands[1]:find('rollback-timer', 1, true))
local activated_pending = get_apply_state()
assert(not string.find(activated_pending[1], first_path, 1, true))
assert(files[first_path] == nil)
clear_pending()

-- ACTIVATEの重複はloadを再実行せず、ABORTも受け付けない。
process_inbound_frame(0x47, 7, '')
expect_result(0x08, nil, 0x0c)
assert(#commands == 1)
clear_pending()
process_inbound_frame(0x49, 7, '')
expect_result(0x08, nil, 0x0c)
assert(#commands == 1)
-- ACTIVATE後はoperation_idが違っても、すでにload境界を越えているため拒否する。
local activated_other_begin = begin_payload(string.rep('B', 16), 3, 3)
clear_pending()
process_inbound_frame(0x44, 8, activated_other_begin)
expect_result(0x08, nil, 0x0c)
assert(#commands == 1)
clear_pending()
reset_apply()
opens = {}
commands = {}

-- 同じoperation_idのBEGINは古いhandleを閉じてtruncateし、stream IDを更新する。
process_inbound_frame(0x44, 9, begin)
clear_pending()
process_inbound_frame(0x45, 9, be32(0) .. 'old')
clear_pending()
local old_path = opens[1].path
local old_file = files[old_path]
process_inbound_frame(0x44, 10, begin)
expect_result(0x01, nil, 0x00)
assert(old_file.closed)
assert(#opens == 2 and opens[2].mode == 'wb')
assert(files[opens[2].path].data == '')
clear_pending()

-- 古いstream IDは新しいApply stateへ書き込まない。
process_inbound_frame(0x45, 9, be32(0) .. 'stale')
assert(#get_apply_state() == 0)
assert(files[opens[2].path].data == '')
process_inbound_frame(0x49, 10, '')
assert(files[opens[2].path] == nil)
reset_apply()
opens = {}

-- load前は別operation_idのBEGINでpartial stagingを捨て、新しいstateを開始する。
local next_operation = string.rep('B', 16)
local next_begin = begin_payload(next_operation, 3, 3)
process_inbound_frame(0x44, 9, begin)
clear_pending()
process_inbound_frame(0x45, 9, be32(0) .. 'old')
clear_pending()
local replaced_path = opens[1].path
local replaced_file = files[replaced_path]
process_inbound_frame(0x44, 10, next_begin)
expect_result(0x01, nil, 0x00)
assert(replaced_file.closed)
assert(files[replaced_path] == nil)
assert(#opens == 2 and opens[2].mode == 'wb')
assert(files[opens[2].path].data == '')
clear_pending()
-- 古いstreamのCHUNKは新しいoperationへ届いても破棄する。
process_inbound_frame(0x45, 9, be32(0) .. 'stale')
assert(files[opens[2].path].data == '')
process_inbound_frame(0x49, 10, '')
assert(files[opens[2].path] == nil)
reset_apply()

-- write失敗時はchunk_ackを返さず、stagingを破棄する。
process_inbound_frame(0x44, 11, begin)
clear_pending()
fail_write = true
process_inbound_frame(0x45, 11, be32(0) .. 'bad')
expect_result(0x05, nil, 0x08)
local _, failed_state = get_apply_state()
assert(failed_state == nil)
fail_write = false

-- file open / close失敗ではready/stagedを返さず、次のBEGINで再試行できる。
reset_apply()
fail_open = true
process_inbound_frame(0x44, 8, begin)
expect_result(0x08, nil, 0x07)
local _, open_failed_state = get_apply_state()
assert(open_failed_state == nil)
fail_open = false
clear_pending()
process_inbound_frame(0x44, 8, begin)
clear_pending()
process_inbound_frame(0x45, 8, be32(0) .. 'abc')
clear_pending()
fail_close = true
process_inbound_frame(0x46, 8, be32(3) .. be32(1))
expect_result(0x05, nil, 0x09)
local _, close_failed_state = get_apply_state()
assert(close_failed_state == nil)
fail_close = false

-- apply_verifyだけを段階的に再試行し、成功試行番号をSYSLOGへ出す。
clear_pending()
sleep_intervals = {}
syslog_messages = {}
local snapshot_attempts = 0
_G.rt.command = function(command)
    assert(command == 'show config')
    snapshot_attempts = snapshot_attempts + 1
    if snapshot_attempts < 3 then
        return false, nil
    end
    return true, 'safe test snapshot'
end
queue_config_snapshot('apply_verify')
assert(snapshot_attempts == 3)
assert(#sleep_intervals == 2 and sleep_intervals[1] == 1 and sleep_intervals[2] == 2)
assert(#syslog_messages == 1 and syslog_messages[1]:find('succeeded on attempt 3 of 5', 1, true))
local pending = get_apply_state()
assert(#pending == 1 and frame_parts(pending[1]) == 0x40)

-- 全試行失敗でも有限回で止まり、CONFIG frameをキューへ入れない。
clear_pending()
sleep_intervals = {}
syslog_messages = {}
snapshot_attempts = 0
_G.rt.command = function()
    snapshot_attempts = snapshot_attempts + 1
    return false, nil
end
queue_config_snapshot('apply_verify')
assert(snapshot_attempts == 5)
assert(#sleep_intervals == 4)
assert(sleep_intervals[1] == 1 and sleep_intervals[2] == 2 and sleep_intervals[3] == 5 and sleep_intervals[4] == 10)
assert(#syslog_messages == 1 and syslog_messages[1]:find('failed after 5 attempts', 1, true))
assert(#get_apply_state() == 0)

-- 他のreasonでは従来どおり1回だけ取得し、再試行しない。
sleep_intervals = {}
syslog_messages = {}
snapshot_attempts = 0
queue_config_snapshot('manual')
assert(snapshot_attempts == 1 and #sleep_intervals == 0)
clear_pending()

-- 初回成功もattempt=1として記録し、実機で成否回数を識別できるようにする。
sleep_intervals = {}
syslog_messages = {}
snapshot_attempts = 0
_G.rt.command = function(command)
    assert(command == 'show config')
    snapshot_attempts = snapshot_attempts + 1
    return true, 'safe test snapshot'
end
queue_config_snapshot('apply_verify')
assert(snapshot_attempts == 1 and #sleep_intervals == 0)
assert(#syslog_messages == 1 and syslog_messages[1]:find('succeeded on attempt 1 of 5', 1, true))
clear_pending()

_G.io = real_io
_G.os = real_os
_G.rt = real_rt
print('ok')
