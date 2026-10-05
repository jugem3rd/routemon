-- SHA-256(RTX830のbitライブラリ用、Issue #7)。
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

return sha256
