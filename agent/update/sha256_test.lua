-- luajit agent/update/sha256_test.lua
-- RTX830のbit(32bit符号なし、bshift / brotateは正で左・負で右)をLuaJITのbitで再現して検証する。
local jit_bit = require('bit')
local M32 = 4294967296
local function u(x) return x % M32 end
bit = {
    band = function(...) return u(jit_bit.band(...)) end,
    bor = function(...) return u(jit_bit.bor(...)) end,
    bxor = function(...) return u(jit_bit.bxor(...)) end,
    bnot = function(x) return u(jit_bit.bnot(x)) end,
    bshift = function(x, n)
        if n >= 0 then return u(jit_bit.lshift(x, n)) end
        return u(jit_bit.rshift(x, -n))
    end,
    brotate = function(x, n)
        if n >= 0 then return u(jit_bit.rol(x, n)) end
        return u(jit_bit.ror(x, -n))
    end,
}
local dir = arg[0]:match('(.*/)') or './'
local sha256 = dofile(dir .. 'sha256.lua')

local function check(input, expected)
    local got = sha256(input)
    assert(got == expected, ('sha256 mismatch for %d bytes: %s'):format(#input, got))
end
check('', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
check('abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
check(('a'):rep(55), '9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318')
check(('a'):rep(56), 'b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a')
check(('a'):rep(64), 'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb')
-- 任意のbyte列: Python hashlibと比較する値を出力する
local s = {}
for i = 0, 999 do s[#s + 1] = string.char((i * 37 + 11) % 256) end
print(sha256(table.concat(s)))
print('ok')
