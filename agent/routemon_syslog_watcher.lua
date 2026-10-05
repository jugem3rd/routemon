-- SYSLOG watcher PoC(Issue #26、docs/core/syslog-design.md §4)。
--
-- rt.syslogwatch()は呼び出している間に出た行しか返さないため(Issue #26で実機確認)、
-- 監視専用のLua taskが常時watchし、Agentはlocal TCPで回収する。
--
-- watch窓の切れ目に出た行は落ちる。実機では2秒窓で20行中1行を落とした(Issue #79)。
-- 窓を長くすると欠落は消えるが(10秒窓で20/20)、rt.syslogwatch()は窓いっぱい待ってから
-- 返すため配信が遅くなる(同条件で約16秒)。そこでLive Logs中だけ窓を短くする。
-- AgentがLive modeの切り替えを L1 / L0 の1行でこのtaskへ通知する。
--
-- Agent(/routemon_agent_*.lua)が 127.0.0.1:PORT へ接続したままにし、watcherは
-- 行が出るたびにLF区切りで流し込む。Agentは待たずに読めるだけ読む。
-- (接続のたびに張り直す方式では、watch中(最大WATCH_SECONDS)はacceptできず、
--  Agent側のtimeoutと行き違って行を落とすことをIssue #26の実機で確認した)
--
-- RTX830へtelnetで配置するため「"」「?」「]]」と小数リテラルを書かない。

local PORT = 4500
-- Live Logs中は応答性を優先し、通常は取りこぼしにくさを優先する
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
        -- 古い行から捨てる。落とした件数はAgent経由でServerへ知らせる
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

-- 溜まっている行をAgentへ流す。送れなければ接続を捨てて溜め直す。
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

-- AgentからのLive mode通知を読む。届いていなければ何もしない。
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
    -- watch中に出た行だけが返る
    local hits, lines = rt.syslogwatch('.', MAX_LINES, window)
    if hits and hits > 0 and lines then
        for i = 1, #lines do
            push(tostring(lines[i]))
        end
        flush()
    end
end
