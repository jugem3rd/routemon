-- Routemon Loader(docs/core/agent-update-design.md §11、Enrollmentから`/routemon_bootstrap.lua`へ配置)。
--
-- Supervisor(`/routemon_supervisor_a.lua` / `_b.lua`)を、同じLua taskの中でpcallして動かす小さな
-- 固定のloader。`schedule at`が起動するpath(`/routemon_bootstrap.lua`)をそのまま使うため、
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
end
