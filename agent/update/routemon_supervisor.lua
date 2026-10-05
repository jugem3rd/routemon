-- Routemon Supervisor(docs/core/agent-update-design.md、Enrollmentから配置)。
--
-- `/routemon_supervisor_a.lua` / `_b.lua`の2 slotのどちらかとして、ローダー
-- (`/routemon_bootstrap.lua`、agent/update/routemon_loader.lua)の中でpcallされて動く。
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
end
