/**
 * Router向けBootstrap Luaの生成(docs/core/device-enrollment-design.md §6)。
 *
 * Bootstrapは共通ロジックで、Enrollmentに必要な最小情報(endpointとCode)だけを埋め込む。
 * 責務: identity送信 -> credential取得 -> device config書き込み -> Agent取得 -> 起動。
 *
 * RTX830のCLIはバックスラッシュを消費し、`"`を含む行はコマンドが分断されるため、
 * Bootstrapのsourceに`"`とバックスラッシュを入れない(docs/core/lua-api-notes.md)。
 */

export type BootstrapOptions = {
	/** Enrollment APIのbase URL(例: https://routemon.example.com) */
	baseUrl: string;
	/** one-time Enrollment Code */
	code: string;
	/** Agentを置くslot(初回はA) */
	agentPath?: string;
	/** SYSLOG watcherの保存先 */
	watcherPath?: string;
	confPath?: string;
	statePath?: string;
	/** Bootstrap / Supervisor(docs/core/agent-update-design.md §2) */
	/** ローダーのpath(`schedule at`が起動する。Supervisorは別のslotへ置く) */
	supervisorPath?: string;
	/** Supervisor slot aのpath */
	supervisorSlotPath?: string;
	sha256Path?: string;
};

export type SupervisorSchedulePlan =
	| { existing: true }
	| { existing: false; scheduleNumber: number };

/**
 * Enrollment Bootstrap内のschedule選択と同じ規則を検証するための純粋関数。
 * schedule番号は設定から使われている番号を集め、1から最小の空きを返す。
 */
export function planSupervisorSchedule(
	config: string,
	supervisorPath = "/routemon_bootstrap.lua",
): SupervisorSchedulePlan {
	const used = new Set<number>();
	const escapedPath = supervisorPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const supervisorCommand = new RegExp(
		`\\blua\\s+${escapedPath}(?:\\s|$)`,
		"i",
	);

	for (const line of config.split(/\r?\n/)) {
		const match = /^\s*schedule\s+at\s+(\d+)\b/i.exec(line);
		if (!match) continue;
		used.add(Number(match[1]));
		if (supervisorCommand.test(line)) return { existing: true };
	}

	let scheduleNumber = 1;
	while (used.has(scheduleNumber)) scheduleNumber += 1;
	return { existing: false, scheduleNumber };
}

// Enrollmentで配置する固定のSYSLOG watcher。正本は
// agent/routemon_syslog_watcher.luaで、コメントと空行を除いた一致をテストする。
// AgentのA/B releaseには含めず、Bootstrapから独立したtaskとしてSupervisorに管理させる。
const SYSLOG_WATCHER_SOURCE = `local PORT = 4500
local WATCH_SECONDS_LIVE = 2
local WATCH_SECONDS_IDLE = 10
local MAX_LINES = 500
local MAX_BYTES = 65536
local LF = string.char(10)
local buffer = {}
local bytes = 0
local dropped = 0
local function push(line)
    if #buffer >= MAX_LINES or bytes + #line > MAX_BYTES then
        local removed = table.remove(buffer, 1)
        if removed then
            bytes = bytes - #removed
            dropped = dropped + 1
        end
    end
    buffer[#buffer + 1] = line
    bytes = bytes + #line
end
local server = rt.socket.tcp()
server:settimeout(1)
local ok, err = server:bind('127.0.0.1', PORT)
if not ok then
    print('syslog watcher: bind failed ' .. tostring(err))
    return
end
server:listen(2)
server:settimeout(0)
print('=== routemon syslog watcher start ===')
local client = nil
local live = false
local function flush()
    if not client or #buffer == 0 then
        return
    end
    if dropped > 0 then
        push('routemon: dropped ' .. dropped .. ' syslog lines')
        dropped = 0
    end
    local payload = table.concat(buffer, LF) .. LF
    local sent = client:send(payload)
    if sent then
        buffer = {}
        bytes = 0
    else
        client:close()
        client = nil
    end
end
local function read_control()
    if not client then
        return
    end
    local data, rerr = client:receive('*l')
    if data == 'L1' then
        live = true
    elseif data == 'L0' then
        live = false
    elseif rerr and rerr ~= 'timeout' then
        client:close()
        client = nil
    end
end
while true do
    if not client then
        client = server:accept()
        if client then
            client:settimeout(0)
            print('syslog watcher: agent connected')
        end
    end
    read_control()
    flush()
    local window = WATCH_SECONDS_IDLE
    if live then
        window = WATCH_SECONDS_LIVE
    end
    local hits, lines = rt.syslogwatch('.', MAX_LINES, window)
    if hits and hits > 0 and lines then
        for i = 1, #lines do
            push(tostring(lines[i]))
        end
        flush()
    end
end`;

// Enrollmentで配置するSupervisor(slot a)。正本はagent/update/routemon_supervisor.luaで、
// コメントと空行を除いた一致をテストする。
const SUPERVISOR_SOURCE = `-- Routemon Supervisor(docs/core/agent-update-design.md、Enrollmentから配置)。
--
-- \`/routemon_supervisor_a.lua\` / \`_b.lua\`の2 slotのどちらかとして、ローダー
-- (\`/routemon_bootstrap.lua\`、agent/update/routemon_loader.lua)の中でpcallされて動く。
-- Supervisor自身の更新(#159)は、ローダーが、候補のslotの起動、確定、旧slotへの復帰を行う。
--
-- AgentをA/B 2 slotで保持し、Agentを別のLua taskとして起動・監視する。
-- - rt.command('lua <file>')で起動、'show status lua running'で生存確認、
--   'terminate lua <id>'で停止する(同一taskでpcallする方式と異なり、固まった
--   candidateも止められ、Agentのmemory不足でSupervisorが道連れにならない)
-- - 更新はinactive slotへdownload・検証してから現行Agentを止め、candidateを起動する
-- - candidateはGatewayとの最初の認証済みsync成功をhealth fileへ書く。期限内に
--   書かれない、version不一致、taskが消えた場合は旧slotへ戻す
--
-- RTX830のCLIが消費する引用符・バックスラッシュ・長括弧の終端記号と、小数リテラルは使わない。
-- (docs/core/lua-api-notes.md)。

local SUPERVISOR_VERSION = '1.1.0'

local CONF_FILE = '/routemon_device.conf'
local STATE_FILE = '/routemon_state.dat'
local STATE_TMP = '/routemon_state.tmp'
local SLOTS = { a = '/routemon_agent_a.lua', b = '/routemon_agent_b.lua' }
local WATCHER = '/routemon_syslog_watcher.lua'
local DOWNLOAD_TMP = '/routemon_agent_dl.tmp'
local HEALTH_FILE = '/routemon_health.dat'
local UPDATE_REQUEST = '/routemon_update.req'
local SHA256_FILE = '/routemon_sha256.lua'
local SELF = '/routemon_bootstrap.lua'

local POLL = 5
local HEALTH_TIMEOUT = 90
local RESTART_BACKOFF = 10
local RECOVERY_RETRY = 300
-- Supervisor自身の更新(#159): 候補は、起動してからこの秒数、Agentが健全に動いたら確定する
local SUP_CONFIRM_SECONDS = 120
-- この秒数を過ぎても確定できない候補は、自分で旧slotへ戻す
local SUP_CONFIRM_TIMEOUT = 600
local SUPERVISOR_PREFIX = 'supervisor-'

local Q = string.char(34)

-- rt.command()で起動されたtaskのprintはconsoleに出ないため、syslogにも出す(#35)
local function log(msg)
    print(os.date('%H:%M:%S') .. ' supervisor: ' .. msg)
    rt.syslog('info', 'routemon supervisor: ' .. msg)
end

local function read_file(path)
    local f = io.open(path, 'rb')
    if not f then
        return nil
    end
    local s = f:read('*a')
    f:close()
    return s
end

local function load_table(path)
    local chunk = loadfile(path)
    if not chunk then
        return nil
    end
    local ok, t = pcall(chunk)
    if ok and type(t) == 'table' then
        return t
    end
    return nil
end

-- state fileは一時fileへ書いてからrenameで置き換える。
local function save_state(st)
    local parts = {}
    for k, v in pairs(st) do
        parts[#parts + 1] = k .. '=' .. string.format('%q', tostring(v))
    end
    local f = io.open(STATE_TMP, 'w')
    f:write('return {' .. table.concat(parts, ',') .. '}')
    f:close()
    os.remove(STATE_FILE)
    os.rename(STATE_TMP, STATE_FILE)
end

-- 'show status lua running'から{id, script}の一覧を取る。task ID行「<id>  (<状態>)」の後の
-- スクリプトファイル行「:<空白>/path.lua」を対応付ける(コマンドライン行は「lua /path.lua」で区別できる)。
local function running_tasks()
    local ok, out = rt.command('show status lua running')
    local tasks = {}
    if not ok or not out then
        return tasks
    end
    local id = nil
    for line in string.gmatch(out, '[^' .. string.char(10) .. ']+') do
        local task_id = string.match(line, '(%d+)%s+%(%u+%)')
        local script = string.match(line, ':%s+(/[%w_%.]+%.lua)')
        if task_id then
            id = task_id
        elseif script and id then
            tasks[#tasks + 1] = { id = id, script = script }
            id = nil
        end
    end
    return tasks
end

local function find_tasks(script)
    local ids = {}
    for _, t in ipairs(running_tasks()) do
        if t.script == script then
            ids[#ids + 1] = t.id
        end
    end
    return ids
end

-- 自分自身をterminateすると、rt.commandが自分の終了を待ち続けてdeadlockし、
-- Luaのタスク生成・停止が以後すべて止まる(Issue #45、電源再投入が必要になる)。
local function terminate_all(script)
    if script == SELF then
        log('refusing to terminate self')
        return
    end
    for _, id in ipairs(find_tasks(script)) do
        rt.command('terminate lua ' .. id)
    end
end

-- 接続先(#147)。Agentが更新した一覧のfileがあれば先頭を使い、無ければdevice configのgatewayを使う。
local ENDPOINTS_FILE = '/routemon_gateways.dat'
local function gateway_url(conf)
    local list = load_table(ENDPOINTS_FILE)
    if list and type(list[1]) == 'string' and list[1] ~= '' then
        return list[1]
    end
    return conf.gateway
end

local function http_get(conf, path, save)
    local req = {
        url = gateway_url(conf) .. path,
        method = 'GET',
        auth_type = 'bearer',
        auth_token = conf.token,
        timeout = 60,
    }
    if save then
        req.save_file = save
    end
    local ok, r = pcall(rt.httprequest, req)
    if not ok then
        return nil, tostring(r)
    end
    if not r.rtn1 then
        return nil, tostring(r.err)
    end
    if tonumber(tostring(r.code)) ~= 200 then
        return nil, 'http ' .. tostring(r.code)
    end
    if save and not r.rtn2 then
        return nil, 'save_file failed'
    end
    return r
end

-- versionのartifactをdownloadし、size / hash / 構文を確認してからdestへ置く。
-- stable aliasではmanifestのversionをAgentの実versionとして返す。
local function install_to(conf, version, dest)
    local r, err = http_get(conf, '/v1/agent/releases/' .. version .. '/manifest')
    if not r then
        return false, 'manifest: ' .. err
    end
    local body = r.body or ''
    local actual_version = string.match(body, Q .. 'version' .. Q .. '%s*:%s*' .. Q .. '([%w%._%-]+)' .. Q)
    local size = tonumber(string.match(body, Q .. 'size' .. Q .. '%s*:%s*(%d+)'))
    local hash = string.match(body, Q .. 'content_hash' .. Q .. '%s*:%s*' .. Q .. '(%x+)' .. Q)
    if not actual_version or not size then
        return false, 'manifest_invalid'
    end
    if version ~= 'stable' and actual_version ~= version then
        return false, 'version_mismatch'
    end
    os.remove(DOWNLOAD_TMP)
    r, err = http_get(conf, '/v1/agent/releases/' .. version, DOWNLOAD_TMP)
    if not r then
        os.remove(DOWNLOAD_TMP)
        return false, 'download: ' .. err
    end
    local data = read_file(DOWNLOAD_TMP)
    if not data or #data ~= size then
        os.remove(DOWNLOAD_TMP)
        return false, 'size_mismatch'
    end
    local sha256_chunk = loadfile(SHA256_FILE)
    if sha256_chunk and hash then
        local started = os.time()
        local got = sha256_chunk()(data)
        log('sha256 ' .. #data .. ' bytes in ' .. (os.time() - started) .. 's')
        if got ~= hash then
            os.remove(DOWNLOAD_TMP)
            return false, 'hash_mismatch'
        end
    else
        log('hash not verified (sha256 helper or content_hash missing)')
    end
    if not loadfile(DOWNLOAD_TMP) then
        os.remove(DOWNLOAD_TMP)
        return false, 'syntax_error'
    end
    os.remove(dest)
    if not os.rename(DOWNLOAD_TMP, dest) then
        return false, 'rename_failed'
    end
    return true, nil, actual_version
end

local function install(conf, version, slot)
    return install_to(conf, version, SLOTS[slot])
end

local function other(slot)
    if slot == 'a' then
        return 'b'
    end
    return 'a'
end

-- Supervisor自身の更新(#159)。非アクティブなslotへdownload・検証(size / hash / 構文)して、
-- ローダーに候補として登録する。登録できたらtrueを返し、呼び出し側はreturnする
-- (ローダーが、候補のSupervisorを起動する)。ローダーの無い環境では拒否する。
local function update_supervisor(conf, request)
    if not routemon_loader then
        return false, 'no_loader'
    end
    local slot = routemon_loader.inactive_slot()
    log('supervisor update ' .. SUPERVISOR_VERSION .. ' -> ' .. request .. ' into slot ' .. slot)
    local ok, err = install_to(conf, request, routemon_loader.slot_path(slot))
    if not ok then
        return false, err
    end
    routemon_loader.stage(slot, string.sub(request, string.len(SUPERVISOR_PREFIX) + 1))
    log('supervisor candidate staged in slot ' .. slot)
    return true
end

-- ---- main ----

local conf = load_table(CONF_FILE)
if not conf then
    log('device config not found: ' .. CONF_FILE)
    return
end
if #find_tasks(SELF) > 1 then
    log('another supervisor is running')
    return
end
-- 前回のSupervisorが残したAgent taskを止めてから始める
terminate_all(SLOTS.a)
terminate_all(SLOTS.b)

-- save_stateのremoveとrenameの間で止まった場合は一時fileが最新の状態
local st = load_table(STATE_FILE) or load_table(STATE_TMP) or { active = 'a' }
local recovery_retry_at = 0

local function rollback(reason)
    log('rollback ' .. st.candidate .. ' (' .. st.candidate_version .. ') -> ' .. st.active .. ': ' .. reason)
    -- Agentが次のAGENT_STATUSでServerへ報告する(#35)
    st.last_rollback = st.candidate_version .. ' ' .. reason
    if st.recovery_pending then
        st.recovery_pending = nil
        recovery_retry_at = os.time() + RECOVERY_RETRY
    end
    st.candidate = nil
    st.candidate_version = nil
    save_state(st)
end

-- candidateの試験中にSupervisorが止まった(reboot等)場合は旧slotへ戻す
if st.candidate and not st.recovery_pending then
    rollback('interrupted')
end

-- 初回導入: active slotが不正でもinactive slotが読める場合は従来どおりinitial_versionを取得する。
-- 両slot不正ならmain loopのrecovery modeでstableを取得する。
if not st.recovery_pending and not loadfile(SLOTS[st.active]) and loadfile(SLOTS[other(st.active)]) then
    local ok, err, actual_version = install(conf, conf.initial_version, st.active)
    if not ok then
        log('initial install failed: ' .. err)
        return
    end
    st.version = actual_version
    save_state(st)
end

-- Agentが、AGENT_STATUSでServerへ報告する(#159)。loaderのstateから、Supervisor自身の更新を
-- 直前に戻した理由も取る
st.supervisor_version = SUPERVISOR_VERSION
local loader_state = load_table('/routemon_sup.dat')
st.supervisor_rollback = loader_state and loader_state.last_rollback or nil
save_state(st)

log('start: active=' .. st.active .. ' version=' .. tostring(st.version) .. ' supervisor=' .. SUPERVISOR_VERSION)
local started_at = os.time()
-- ローダーが、更新で置かれた候補として起動した場合は、健全と確認できたら確定する
local supervisor_unconfirmed = routemon_loader ~= nil and routemon_loader.is_candidate()
local running = false
local deadline = 0
local watcher_running = false
local watcher_restart_at = 0
local watcher_unusable_logged = false

while true do
    -- watcherはAgentとは別のtaskとして常駐させ、消えたら再起動する。
    if watcher_running then
        if #find_tasks(WATCHER) == 0 then
            watcher_running = false
            watcher_restart_at = os.time() + RESTART_BACKOFF
            log('syslog watcher exited, restart in ' .. RESTART_BACKOFF .. 's')
        end
    elseif #find_tasks(WATCHER) > 0 then
        -- Supervisor再起動時に既存watcherが残っていれば、それを監視対象にする。
        watcher_running = true
    elseif os.time() >= watcher_restart_at then
        if loadfile(WATCHER) then
            watcher_unusable_logged = false
            rt.command('lua ' .. WATCHER)
            watcher_running = true
            log('started syslog watcher')
        else
            if not watcher_unusable_logged then
                log('syslog watcher file unusable: ' .. WATCHER)
                watcher_unusable_logged = true
            end
            watcher_restart_at = os.time() + RESTART_BACKOFF
        end
    end

    local slot = st.candidate or st.active
    local alive = running and #find_tasks(SLOTS[slot]) > 0

    if supervisor_unconfirmed then
        local age = os.time() - started_at
        if alive and not st.candidate and age >= SUP_CONFIRM_SECONDS and read_file(HEALTH_FILE) then
            -- Agentが認証済みsyncに成功している状態で、一定時間動き続けた
            if routemon_loader.confirm() then
                supervisor_unconfirmed = false
            end
        elseif age > SUP_CONFIRM_TIMEOUT then
            log('supervisor candidate not confirmed in ' .. SUP_CONFIRM_TIMEOUT .. 's, rolling back')
            routemon_loader.rollback('unconfirmed')
            return
        end
    end

    if not alive then
        if running then
            running = false
            if st.candidate then
                rollback('agent_exited')
            else
                log('agent exited, restart in ' .. RESTART_BACKOFF .. 's')
                rt.sleep(RESTART_BACKOFF)
            end
        else
            slot = st.candidate or st.active
            if loadfile(SLOTS[slot]) then
                os.remove(HEALTH_FILE)
                rt.command('lua ' .. SLOTS[slot])
                running = true
                deadline = os.time() + HEALTH_TIMEOUT
                log('started slot ' .. slot)
            elseif st.candidate then
                rollback('syntax_error')
            elseif st.recovery_needed or (not loadfile(SLOTS[st.active]) and not loadfile(SLOTS[other(st.active)])) then
                if not st.recovery_needed then
                    log('both agent slots unusable, entering recovery mode')
                    st.recovery_needed = true
                    save_state(st)
                end
                if os.time() >= recovery_retry_at then
                    log('recovery: downloading stable Agent into slot a')
                    local ok, err, actual_version = install(conf, 'stable', 'a')
                    if ok then
                        st.active = 'a'
                        st.version = actual_version
                        st.candidate = 'a'
                        st.candidate_version = actual_version
                        st.recovery_pending = true
                        st.last_rollback = 'recovered_both_slots_invalid'
                        save_state(st)
                        log('recovery: installed ' .. actual_version .. ', waiting for authenticated sync')
                    else
                        log('recovery failed: ' .. err .. ', retry in ' .. RECOVERY_RETRY .. 's')
                        recovery_retry_at = os.time() + RECOVERY_RETRY
                    end
                end
            else
                log('active slot unusable')
                rt.sleep(60)
            end
        end
    elseif st.candidate then
        local version = read_file(HEALTH_FILE)
        if version == st.candidate_version then
            log('candidate ' .. version .. ' healthy, active=' .. st.candidate)
            st.active = st.candidate
            st.version = version
            st.candidate = nil
            st.candidate_version = nil
            st.recovery_pending = nil
            st.recovery_needed = nil
            save_state(st)
        elseif version then
            terminate_all(SLOTS[slot])
            running = false
            rollback('version_mismatch (' .. version .. ')')
        elseif os.time() > deadline then
            terminate_all(SLOTS[slot])
            running = false
            rollback('startup_timeout')
        end
    else
        -- Gatewayの更新通知を受けたAgentがこのfileへversionを書く。
        local request = read_file(UPDATE_REQUEST)
        local version = nil
        if request then
            os.remove(UPDATE_REQUEST)
            version = string.match(request, '[%w%._%-]+')
            if version and string.sub(version, 1, string.len(SUPERVISOR_PREFIX)) == SUPERVISOR_PREFIX then
                -- Supervisor自身の更新(#159)
                local ok, err = update_supervisor(conf, version)
                if ok then
                    return
                end
                log('supervisor update rejected: ' .. err)
                st.last_update_error = version .. ' ' .. err
                save_state(st)
                version = nil
            end
        end
        if version then
            local target = other(st.active)
            log('update ' .. tostring(st.version) .. ' -> ' .. version .. ' into slot ' .. target)
            local ok, err, actual_version = install(conf, version, target)
            if ok then
                st.candidate = target
                st.candidate_version = actual_version
                save_state(st)
                terminate_all(SLOTS[st.active])
                running = false
            else
                log('update rejected: ' .. err)
                st.last_update_error = version .. ' ' .. err
                save_state(st)
            end
        end
    end
    rt.sleep(POLL)
end`;

// Enrollmentで`/routemon_bootstrap.lua`へ配置する固定のローダー(#159)。正本はagent/update/routemon_loader.lua。
const LOADER_SOURCE = `-- Routemon Loader(docs/core/agent-update-design.md §11、Enrollmentから\`/routemon_bootstrap.lua\`へ配置)。
--
-- Supervisor(\`/routemon_supervisor_a.lua\` / \`_b.lua\`)を、同じLua taskの中でpcallして動かす小さな
-- 固定のloader。\`schedule at\`が起動するpath(\`/routemon_bootstrap.lua\`)をそのまま使うため、
-- Routerの設定を変えずに、Supervisor自身をA/Bで更新できる(#159)。
--
-- - Supervisorが落ちたら捕まえて、再起動する(Supervisorの見張りを兼ねる)
-- - 更新で置かれた候補のSupervisorが、起動中に落ちる・構文エラー・確定しないまま終了した場合は、
--   すぐに旧slotへ戻す。確定しないまま再起動(Router reboot等)を繰り返した場合も、戻す
-- - Supervisorへは、グローバルのroutemon_loaderで、slotの情報・候補の登録(stage)・確定(confirm)
--   ・戻し(rollback)を渡す
--
-- このfile自身は更新しない(固定)。小さく保ち、変更が必要になる理由を減らす。
-- RTX830のCLIが消費する引用符・バックスラッシュ・長括弧の終端記号と、小数リテラルは使わない。

local SELF = '/routemon_bootstrap.lua'
local STATE_FILE = '/routemon_sup.dat'
local STATE_TMP = '/routemon_sup.tmp'
local SLOTS = { a = '/routemon_supervisor_a.lua', b = '/routemon_supervisor_b.lua' }
-- 確定しないまま、候補を起動できる回数
local MAX_STARTS = 3
local RESTART_BACKOFF = 10
local NO_SUPERVISOR_RETRY = 60

local function log(msg)
    print(os.date('%H:%M:%S') .. ' loader: ' .. msg)
    rt.syslog('info', 'routemon loader: ' .. msg)
end

local function load_table(path)
    local chunk = loadfile(path)
    if not chunk then
        return nil
    end
    local ok, t = pcall(chunk)
    if ok and type(t) == 'table' then
        return t
    end
    return nil
end

local function other(slot)
    if slot == 'a' then
        return 'b'
    end
    return 'a'
end

-- stateは一時fileへ書いてからrenameで置き換える。
local function save_state(st)
    local parts = {}
    for k, v in pairs(st) do
        parts[#parts + 1] = k .. '=' .. string.format('%q', tostring(v))
    end
    local f = io.open(STATE_TMP, 'w')
    if not f then
        return
    end
    f:write('return {' .. table.concat(parts, ',') .. '}')
    f:close()
    os.remove(STATE_FILE)
    os.rename(STATE_TMP, STATE_FILE)
end

-- 'show status lua running'から、scriptを実行中のtask IDを返す。
local function count_tasks(script)
    local ok, out = rt.command('show status lua running')
    local n = 0
    if not ok or not out then
        return n
    end
    local have_id = false
    for line in string.gmatch(out, '[^' .. string.char(10) .. ']+') do
        local task_id = string.match(line, '(%d+)%s+%(%u+%)')
        local path = string.match(line, ':%s+(/[%w_%.]+%.lua)')
        if task_id then
            have_id = true
        elseif path and have_id then
            if path == script then
                n = n + 1
            end
            have_id = false
        end
    end
    return n
end

if count_tasks(SELF) > 1 then
    log('another loader is running')
    return
end

-- save_stateのremoveとrenameの間で止まった場合は一時fileが最新の状態
local st = load_table(STATE_FILE) or load_table(STATE_TMP) or { active = 'a' }
if st.active ~= 'a' and st.active ~= 'b' then
    st.active = 'a'
end
local running_slot = nil
-- 候補を旧slotへ戻した直後か(戻したら、待たずに旧slotで再起動する)
local reverted = false

local function revert(reason)
    reverted = true
    log('rollback supervisor ' .. tostring(st.candidate_version) .. ' -> ' .. st.active .. ': ' .. reason)
    st.last_rollback = tostring(st.candidate_version) .. ' ' .. reason
    st.candidate = nil
    st.candidate_version = nil
    st.starts = nil
    save_state(st)
end

-- Supervisorへ渡すAPI。Supervisorは、同じLua stateの中で動く。
routemon_loader = {
    slot_path = function(slot)
        return SLOTS[slot]
    end,
    -- 更新で置かれるslot(今動いていない方)
    inactive_slot = function()
        return other(running_slot or st.active)
    end,
    is_candidate = function()
        return st.candidate ~= nil and st.candidate == running_slot
    end,
    -- 新しいSupervisorをslotへ置いた。Supervisorがreturnしたら、ローダーが候補として起動する。
    stage = function(slot, version)
        st.candidate = slot
        st.candidate_version = version
        st.starts = 0
        save_state(st)
    end,
    -- 候補のSupervisorが健全と確認できた。以降、このslotをactiveにする。
    confirm = function()
        if st.candidate and st.candidate == running_slot then
            log('supervisor ' .. tostring(st.candidate_version) .. ' confirmed, active=' .. st.candidate)
            st.active = st.candidate
            st.version = st.candidate_version
            st.candidate = nil
            st.candidate_version = nil
            st.starts = nil
            save_state(st)
            return true
        end
        return false
    end,
    -- 候補のSupervisorが、自分で確定できないと判断した。Supervisorがreturnしたら旧slotで再起動する。
    rollback = function(reason)
        if st.candidate and st.candidate == running_slot then
            revert(reason)
        end
    end,
}

log('start: active=' .. st.active .. ' candidate=' .. tostring(st.candidate))
while true do
    local slot = st.candidate or st.active
    if st.candidate then
        -- 確定しないまま起動した回数を数える(Router rebootをまたいでも続く)
        st.starts = (tonumber(st.starts) or 0) + 1
        if st.starts > MAX_STARTS then
            revert('unconfirmed after ' .. MAX_STARTS .. ' starts')
            slot = st.active
        else
            save_state(st)
        end
    end

    local chunk = loadfile(SLOTS[slot])
    if not chunk then
        if st.candidate then
            revert('syntax_error')
        elseif loadfile(SLOTS[other(st.active)]) then
            log('supervisor slot ' .. st.active .. ' unusable, switching to ' .. other(st.active))
            st.active = other(st.active)
            save_state(st)
        else
            log('no usable supervisor, retry in ' .. NO_SUPERVISOR_RETRY .. 's')
            rt.sleep(NO_SUPERVISOR_RETRY)
        end
    else
        running_slot = slot
        local was_candidate = st.candidate ~= nil and st.candidate == slot
        reverted = false
        log('run supervisor slot ' .. slot)
        local ok, err = pcall(chunk)
        running_slot = nil
        if was_candidate and st.candidate == slot then
            -- 確定する前に、候補が終わった
            if ok then
                revert('exited')
            else
                revert('crashed: ' .. tostring(err))
            end
        end
        if reverted then
            -- 候補を戻した(候補が自分で戻した場合を含む)。待たずに、旧slotで再起動する
            reverted = false
        elseif not ok then
            log('supervisor crashed: ' .. tostring(err) .. ', restart in ' .. RESTART_BACKOFF .. 's')
            rt.sleep(RESTART_BACKOFF)
        elseif not st.candidate then
            -- Supervisorが正常に終わった(deviceの設定が無いなど)。間をあけて、やり直す
            rt.sleep(NO_SUPERVISOR_RETRY)
        end
        -- Supervisorが候補を登録してreturnした場合は、すぐに候補で再起動する
    end
end`;

// EnrollmentでRouterへ配置するSHA-256(Supervisorが、downloadしたAgentのhashを検証するのに使う)。
// 正本はagent/update/sha256.luaで、コメントと空行を除いた一致をテストする(#164)。
const SHA256_SOURCE = `-- SHA-256(RTX830のbitライブラリ用、Issue #7)。
-- RTX830のbitは32bit符号なしで、bshift / brotateは正で左、負で右(docs/core/lua-api-notes.md)。
-- ponytail: 小数リテラル・math.floor・string.format('%x')の32bit超を避ける。
local band, bor, bxor, bnot = bit.band, bit.bor, bit.bxor, bit.bnot
local shr = function(x, n) return bit.bshift(x, -n) end
local ror = function(x, n) return bit.brotate(x, -n) end
local M32 = 4294967296

local K = {
    1116352408, 1899447441, 3049323471, 3921009573, 961987163, 1508970993, 2453635748, 2870763221,
    3624381080, 310598401, 607225278, 1426881987, 1925078388, 2162078206, 2614888103, 3248222580,
    3835390401, 4022224774, 264347078, 604807628, 770255983, 1249150122, 1555081692, 1996064986,
    2554220882, 2821834349, 2952996808, 3210313671, 3336571891, 3584528711, 113926993, 338241895,
    666307205, 773529912, 1294757372, 1396182291, 1695183700, 1986661051, 2177026350, 2456956037,
    2730485921, 2820302411, 3259730800, 3345764771, 3516065817, 3600352804, 4094571909, 275423344,
    430227734, 506948616, 659060556, 883997877, 958139571, 1322822218, 1537002063, 1747873779,
    1955562222, 2024104815, 2227730452, 2361852424, 2428436474, 2756734187, 3204031479, 3329325298,
}

local function hex32(n)
    local lo = n % 65536
    return string.format('%04x%04x', (n - lo) / 65536, lo)
end

local function sha256(msg)
    local len = #msg
    local tail = len % 64
    local pad = 55 - tail
    if pad < 0 then
        pad = pad + 64
    end
    local bits = len * 8
    local lenbytes = {}
    for i = 8, 1, -1 do
        local b = bits % 256
        lenbytes[i] = string.char(b)
        bits = (bits - b) / 256
    end
    msg = msg .. string.char(128) .. string.rep(string.char(0), pad) .. table.concat(lenbytes)

    local h0, h1, h2, h3 = 1779033703, 3144134277, 1013904242, 2773480762
    local h4, h5, h6, h7 = 1359893119, 2600822924, 528734635, 1541459225
    local w = {}
    for chunk = 1, #msg, 64 do
        for i = 0, 15 do
            local b1, b2, b3, b4 = string.byte(msg, chunk + i * 4, chunk + i * 4 + 3)
            w[i] = ((b1 * 256 + b2) * 256 + b3) * 256 + b4
        end
        for i = 16, 63 do
            local x, y = w[i - 15], w[i - 2]
            local s0 = bxor(ror(x, 7), ror(x, 18), shr(x, 3))
            local s1 = bxor(ror(y, 17), ror(y, 19), shr(y, 10))
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) % M32
        end
        local a, b, c, d, e, f, g, h = h0, h1, h2, h3, h4, h5, h6, h7
        for i = 0, 63 do
            local S1 = bxor(ror(e, 6), ror(e, 11), ror(e, 25))
            local ch = bxor(band(e, f), band(bnot(e), g))
            local t1 = (h + S1 + ch + K[i + 1] + w[i]) % M32
            local S0 = bxor(ror(a, 2), ror(a, 13), ror(a, 22))
            local maj = bxor(band(a, b), band(a, c), band(b, c))
            local t2 = (S0 + maj) % M32
            h, g, f, e, d, c, b, a = g, f, e, (d + t1) % M32, c, b, a, (t1 + t2) % M32
        end
        h0, h1, h2, h3 = (h0 + a) % M32, (h1 + b) % M32, (h2 + c) % M32, (h3 + d) % M32
        h4, h5, h6, h7 = (h4 + e) % M32, (h5 + f) % M32, (h6 + g) % M32, (h7 + h) % M32
    end
    return hex32(h0) .. hex32(h1) .. hex32(h2) .. hex32(h3) .. hex32(h4) .. hex32(h5) .. hex32(h6) .. hex32(h7)
end

return sha256`;

export function renderBootstrap(options: BootstrapOptions): string {
	const agentPath = options.agentPath ?? "/routemon_agent_a.lua";
	const watcherPath = options.watcherPath ?? "/routemon_syslog_watcher.lua";
	const confPath = options.confPath ?? "/routemon_device.conf";
	const statePath = options.statePath ?? "/routemon_state.dat";
	const supervisorPath = options.supervisorPath ?? "/routemon_bootstrap.lua";
	const supervisorSlotPath =
		options.supervisorSlotPath ?? "/routemon_supervisor_a.lua";
	const sha256Path = options.sha256Path ?? "/routemon_sha256.lua";
	return `-- Routemon bootstrap(自動生成、docs/core/device-enrollment-design.md §6)
local BASE = '${options.baseUrl}'
local CODE = '${options.code}'
local CONF = '${confPath}'
local AGENT = '${agentPath}'
local WATCHER = '${watcherPath}'
local STATE = '${statePath}'
local SUPERVISOR = '${supervisorPath}'
local SUPERVISOR_SLOT_A = '${supervisorSlotPath}'
local SUPERVISOR_SLOT_B = '/routemon_supervisor_b.lua'
local SUPERVISOR_STATE = '/routemon_sup.dat'
local SUPERVISOR_STATE_TMP = '/routemon_sup.tmp'
local SHA256 = '${sha256Path}'
local ENROLL_SELF = '/routemon_enroll.lua'
local Q = string.char(34)

local function post(path, body)
    local ok, r = pcall(rt.httprequest, {
        url = BASE .. path,
        method = 'POST',
        auth_type = 'bearer',
        auth_token = CODE,
        content_type = 'application/json',
        post_text = body,
        timeout = 30,
    })
    if not ok or not r.rtn1 or tonumber(tostring(r.code)) ~= 200 then
        return nil
    end
    return r.body
end

local function field(body, name)
    return string.match(body, Q .. name .. Q .. '%s*:%s*' .. Q .. '([^' .. Q .. ']+)' .. Q)
end

-- Router identity(取得できる範囲、§7)
local ok_env, env = rt.command('show environment')
local model, firmware, serial
if ok_env then
    model = string.match(env, '(RTX%w+) Rev')
    firmware = string.match(env, 'Rev%.([%w%.]+)')
    serial = string.match(env, 'serial=(%w+)')
end
local identity = '{' .. Q .. 'model' .. Q .. ':' .. Q .. tostring(model) .. Q
    .. ',' .. Q .. 'firmwareRevision' .. Q .. ':' .. Q .. tostring(firmware) .. Q
    .. ',' .. Q .. 'serialNumber' .. Q .. ':' .. Q .. tostring(serial) .. Q .. '}'

print('routemon bootstrap: enrolling')
local body = post('/v1/enrollment/complete', identity)
if not body then
    print('routemon bootstrap: enrollment failed')
    return
end

local device_id = field(body, 'deviceId')
local token = field(body, 'deviceToken')
local gateway = field(body, 'gateway')
local release = field(body, 'agentVersion')
if not device_id or not token or not gateway or not release then
    print('routemon bootstrap: invalid enrollment response')
    return
end

-- stable aliasのmanifestからAgentが報告する実versionを読む。
local ok_manifest, manifest = pcall(rt.httprequest, {
    url = gateway .. '/v1/agent/releases/' .. tostring(release) .. '/manifest',
    method = 'GET',
    auth_type = 'bearer',
    auth_token = token,
    timeout = 60,
})
if not ok_manifest or not manifest or not manifest.rtn1 or tonumber(tostring(manifest.code)) ~= 200 then
    print('routemon bootstrap: agent manifest failed')
    return
end
local version = field(manifest.body or '', 'version')
if not version or not string.match(version, '^[%w%._%-]+$') then
    print('routemon bootstrap: agent manifest invalid')
    return
end

local conf = io.open(CONF, 'w')
conf:write('return {device_id=' .. Q .. device_id .. Q
    .. ', token=' .. Q .. token .. Q
    .. ', gateway=' .. Q .. gateway .. Q
    .. ', initial_version=' .. Q .. tostring(release) .. Q .. '}')
conf:close()
print('routemon bootstrap: device config written')

-- Agent本体を取得する(Device Tokenで認証、docs/core/agent-update-design.md §4)
local ok_agent, r = pcall(rt.httprequest, {
    url = gateway .. '/v1/agent/releases/' .. tostring(release),
    method = 'GET',
    auth_type = 'bearer',
    auth_token = token,
    timeout = 60,
    save_file = AGENT,
})
if not ok_agent or not r.rtn1 or not r.rtn2 or tonumber(tostring(r.code)) ~= 200 then
    print('routemon bootstrap: agent download failed')
    return
end
if not loadfile(AGENT) then
    print('routemon bootstrap: agent syntax error')
    os.remove(AGENT)
    return
end

-- SYSLOG watcherはEnrollment時に配置し、以後はSupervisorが生存監視する
local watcher = io.open(WATCHER, 'w')
if not watcher then
    print('routemon bootstrap: watcher write failed')
    return
end
watcher:write([=[
${SYSLOG_WATCHER_SOURCE}
]=])
watcher:close()
if not loadfile(WATCHER) then
    print('routemon bootstrap: watcher syntax error')
    os.remove(WATCHER)
    return
end

-- SupervisorはEnrollmentごとに現行の正本で、slot aへ置き換える。Supervisorの更新(#159)は、固定のローダー
-- (schedule atが起動する/routemon_bootstrap.lua)が、slot aとbを切り替えて行う。
local supervisor = io.open(SUPERVISOR_SLOT_A, 'w')
if not supervisor then
    print('routemon bootstrap: supervisor write failed')
    return
end
supervisor:write([=[
${SUPERVISOR_SOURCE}
]=])
supervisor:close()
if not loadfile(SUPERVISOR_SLOT_A) then
    print('routemon bootstrap: supervisor syntax error')
    os.remove(SUPERVISOR_SLOT_A)
    return
end

-- ローダーは固定で、Supervisorを起動するpath(SUPERVISOR)へ置く。
local loader = io.open(SUPERVISOR, 'w')
if not loader then
    print('routemon bootstrap: loader write failed')
    return
end
loader:write([=[
${LOADER_SOURCE}
]=])
loader:close()
if not loadfile(SUPERVISOR) then
    print('routemon bootstrap: loader syntax error')
    os.remove(SUPERVISOR)
    return
end

-- Supervisorのslotを初期化する(slot aをactiveにし、前回の候補とslot bを消す)。
local supervisor_state = io.open(SUPERVISOR_STATE, 'w')
if not supervisor_state then
    print('routemon bootstrap: supervisor state write failed')
    return
end
supervisor_state:write('return {active=' .. Q .. 'a' .. Q .. '}')
supervisor_state:close()
os.remove(SUPERVISOR_STATE_TMP)
os.remove(SUPERVISOR_SLOT_B)

-- SupervisorがAgent更新のhashを検証するためのSHA-256(無いとhashの検証が省略される、#164)。
local sha256 = io.open(SHA256, 'w')
if not sha256 then
    print('routemon bootstrap: sha256 write failed')
    return
end
sha256:write([=[
${SHA256_SOURCE}
]=])
sha256:close()
local sha256_chunk = loadfile(SHA256)
if not sha256_chunk then
    print('routemon bootstrap: sha256 syntax error')
    os.remove(SHA256)
    return
end
-- 既知の入力で正しいhashを返すことを確認する
if sha256_chunk()('abc') ~= 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' then
    print('routemon bootstrap: sha256 self-test failed')
    os.remove(SHA256)
    return
end

-- stateを初期化し、Agentの起動は必ずSupervisorへ委ねる。
local state = io.open(STATE, 'w')
if not state then
    print('routemon bootstrap: state write failed')
    return
end
state:write('return {active=' .. Q .. 'a' .. Q .. ', version=' .. Q .. tostring(version) .. Q .. '}')
state:close()

-- 既存番号を避け、Supervisorを起動するscheduleが無い場合だけ1行追加して保存する。
local ok_config, config = rt.command('show config')
if not ok_config or not config then
    print('routemon bootstrap: config read failed')
    return
end
local occupied = {}
local has_supervisor_schedule = false
for line in string.gmatch(config, '[^' .. string.char(10) .. ']+') do
    local lower = string.lower(line)
    local number = string.match(lower, '^%s*schedule%s+at%s+(%d+)')
    if number then
        occupied[number] = true
        local _, finish = string.find(lower, 'lua%s+(/[%w_%.]+%.lua)')
        if finish then
            local script = string.match(lower, 'lua%s+(/[%w_%.]+%.lua)')
            local next_char = string.sub(lower, finish + 1, finish + 1)
            if script == string.lower(SUPERVISOR)
                and (next_char == '' or string.match(next_char, '%s')) then
                has_supervisor_schedule = true
            end
        end
    end
end

if not has_supervisor_schedule then
    local number = 1
    while occupied[tostring(number)] do
        number = number + 1
    end
    local ok_schedule = rt.command('schedule at ' .. number .. ' +15 * lua ' .. SUPERVISOR)
    if not ok_schedule then
        print('routemon bootstrap: supervisor schedule failed')
        return
    end
    local ok_save = rt.command('save')
    if not ok_save then
        print('routemon bootstrap: config save failed')
        return
    end
    print('routemon bootstrap: supervisor schedule saved')
else
    print('routemon bootstrap: supervisor schedule already configured')
end

-- 旧Supervisor・Agent・watcherを止める。実行中のEnrollment task自身は除外する。
local ok_tasks, running = rt.command('show status lua running')
if not ok_tasks or not running then
    print('routemon bootstrap: Lua task list failed')
    return
end
local supervisor_ids = {}
local other_task_ids = {}
local task_id = nil
for line in string.gmatch(running, '[^' .. string.char(10) .. ']+') do
    local found_id = string.match(line, '(%d+)%s+%(%u+%)')
    local script = string.match(line, ':%s+(/[%w_%.]+%.lua)')
    if found_id then
        task_id = found_id
    elseif script and task_id then
        if string.sub(script, 1, 10) == '/routemon_'
            and string.sub(script, -4) == '.lua'
            and script ~= ENROLL_SELF then
            if script == SUPERVISOR then
                supervisor_ids[#supervisor_ids + 1] = task_id
            else
                other_task_ids[#other_task_ids + 1] = task_id
            end
        end
        task_id = nil
    end
end

for _, task_group in ipairs({ supervisor_ids, other_task_ids }) do
    for _, id in ipairs(task_group) do
        local ok_stop = rt.command('terminate lua ' .. id)
        if not ok_stop then
            print('routemon bootstrap: previous Lua task stop failed')
            return
        end
    end
end

local ok_start = rt.command('lua ' .. SUPERVISOR)
if not ok_start then
    print('routemon bootstrap: supervisor start failed')
    return
end
print('routemon bootstrap: supervisor started')

-- 成功後だけEnrollment sourceを消す。失敗時は調査できるように残す。
local removed = os.remove(ENROLL_SELF)
if not removed then
    print('routemon bootstrap: enrollment file removal failed')
else
    print('routemon bootstrap: enrollment file removed')
end
`;
}

/**
 * GUIが表示するcopy-paste用のCLI block(§9)。
 * 利用者はCodeもLua sourceも編集しない。
 */
export function renderCliBlock(options: {
	baseUrl: string;
	code: string;
	bootstrapPath?: string;
}): string {
	// Supervisor(/routemon_bootstrap.lua)を上書きしないよう、Enrollment用は別pathにする
	const bootstrapPath = options.bootstrapPath ?? "/routemon_enroll.lua";
	// RTX830のCLIは引数を「"」で囲む。Lua source側の文字列はすべて「'」にする
	// (docs/core/lua-api-notes.md)。
	const inline =
		`lua -e "local r = rt.httprequest({url = '${options.baseUrl}/v1/enrollment/bootstrap', ` +
		`method = 'GET', auth_type = 'bearer', auth_token = '${options.code}', ` +
		`timeout = 30, save_file = '${bootstrapPath}'}) print(r.rtn1, r.rtn2, r.code)"`;
	return `${inline}\nlua ${bootstrapPath}`;
}
