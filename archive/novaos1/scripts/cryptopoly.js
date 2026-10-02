/*!
 * NovaOS cryptopoly — minimal SubtleCrypto polyfill for non-secure (HTTP) origins.
 * Only implements the surface NovaOS uses:
 *   importKey("raw", ..., PBKDF2) / deriveKey(PBKDF2-SHA256 -> AES-GCM 256)
 *   encrypt / decrypt (AES-GCM, 96-bit IV, 128-bit tag, optional AAD)
 * Pure JS, ES5+typed arrays. On secure contexts the native subtle is kept.
 */
(function (global) {
    "use strict";

    function makeSubtle() {

        /* ---------------- SHA-256 (FIPS 180-4) ---------------- */
        var K = [
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
            0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
            0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
            0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
            0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
            0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
            0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
        ];
        function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

        function sha256Bytes(data) {
            var h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a,
                h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

            var len = data.length;
            var total = len + 1 + 8;
            var padLen = ((total + 63) & ~63) - len; // includes 0x80 + zeros + 8 length bytes
            var buf = new Uint8Array(len + padLen);
            buf.set(data);
            buf[len] = 0x80;
            var bitHi = Math.floor(len / 0x20000000);
            var bitLo = (len << 3) >>> 0;
            var dp = buf.length - 8;
            buf[dp] = (bitHi >>> 24) & 255; buf[dp + 1] = (bitHi >>> 16) & 255;
            buf[dp + 2] = (bitHi >>> 8) & 255; buf[dp + 3] = bitHi & 255;
            buf[dp + 4] = (bitLo >>> 24) & 255; buf[dp + 5] = (bitLo >>> 16) & 255;
            buf[dp + 6] = (bitLo >>> 8) & 255; buf[dp + 7] = bitLo & 255;

            var w = new Uint32Array(64);
            for (var off = 0; off < buf.length; off += 64) {
                for (var i = 0; i < 16; i++) {
                    var o = off + i * 4;
                    w[i] = ((buf[o] << 24) | (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3]) >>> 0;
                }
                for (i = 16; i < 64; i++) {
                    var s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
                    var s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
                    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
                }
                var a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
                for (i = 0; i < 64; i++) {
                    var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
                    var ch = (e & f) ^ (~e & g);
                    var t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
                    var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
                    var maj = (a & b) ^ (a & c) ^ (b & c);
                    var t2 = (S0 + maj) >>> 0;
                    h = g; g = f; f = e; e = (d + t1) >>> 0;
                    d = c; c = b; b = a; a = (t1 + t2) >>> 0;
                }
                h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
                h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
            }
            var out = new Uint8Array(32);
            var hs = [h0, h1, h2, h3, h4, h5, h6, h7];
            for (i = 0; i < 8; i++) {
                out[i * 4] = (hs[i] >>> 24) & 255;
                out[i * 4 + 1] = (hs[i] >>> 16) & 255;
                out[i * 4 + 2] = (hs[i] >>> 8) & 255;
                out[i * 4 + 3] = hs[i] & 255;
            }
            return out;
        }

        function hmacSha256(key, msg) {
            var block = new Uint8Array(64);
            if (key.length > 64) key = sha256Bytes(key);
            block.set(key);
            var ipad = new Uint8Array(64), opad = new Uint8Array(64);
            for (var i = 0; i < 64; i++) { ipad[i] = block[i] ^ 0x36; opad[i] = block[i] ^ 0x5c; }
            var inner = new Uint8Array(64 + msg.length);
            inner.set(ipad); inner.set(msg, 64);
            var innerHash = sha256Bytes(inner);
            var outer = new Uint8Array(96);
            outer.set(opad); outer.set(innerHash, 64);
            return sha256Bytes(outer);
        }

        function pbkdf2Sha256(password, salt, iterations, dkLen) {
            var hLen = 32, blocks = Math.ceil(dkLen / hLen);
            var dk = new Uint8Array(blocks * hLen);
            var intBuf = new Uint8Array(4);
            for (var block = 1; block <= blocks; block++) {
                intBuf[0] = (block >>> 24) & 255; intBuf[1] = (block >>> 16) & 255;
                intBuf[2] = (block >>> 8) & 255; intBuf[3] = block & 255;
                var m1 = new Uint8Array(salt.length + 4);
                m1.set(salt); m1.set(intBuf, salt.length);
                var u = hmacSha256(password, m1);
                var t = u.slice();
                for (var it = 1; it < iterations; it++) {
                    u = hmacSha256(password, u);
                    for (var j = 0; j < hLen; j++) t[j] ^= u[j];
                }
                dk.set(t, (block - 1) * hLen);
            }
            return dk.slice(0, dkLen);
        }

        /* ---------------- AES (FIPS-197) ---------------- */
        var SBOX = new Uint8Array([
            0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
            0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
            0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
            0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
            0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
            0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
            0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
            0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
            0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
            0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
            0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
            0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
            0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
            0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
            0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
            0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16
        ]);
        var INV_SBOX = new Uint8Array(256);
        for (var s = 0; s < 256; s++) INV_SBOX[SBOX[s]] = s;
        var RCON = [0x00,0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1b,0x36,0x6c,0xd8,0xab,0x4d];

        function keyExpansion(key) {
            var Nk = key.length / 4, Nr = Nk + 6, words = new Uint8Array(4 * 4 * (Nr + 1));
            words.set(key);
            var temp = new Uint8Array(4);
            var total = 4 * (Nr + 1);
            for (var i = Nk; i < total; i++) {
                temp[0] = words[(i - 1) * 4]; temp[1] = words[(i - 1) * 4 + 1];
                temp[2] = words[(i - 1) * 4 + 2]; temp[3] = words[(i - 1) * 4 + 3];
                if (i % Nk === 0) {
                    var t = temp[0];
                    temp[0] = SBOX[temp[1]] ^ RCON[i / Nk];
                    temp[1] = SBOX[temp[2]];
                    temp[2] = SBOX[temp[3]];
                    temp[3] = SBOX[t];
                } else if (Nk > 6 && i % Nk === 4) {
                    temp[0] = SBOX[temp[0]]; temp[1] = SBOX[temp[1]];
                    temp[2] = SBOX[temp[2]]; temp[3] = SBOX[temp[3]];
                }
                var base = i * 4, prev = (i - Nk) * 4;
                words[base] = words[prev] ^ temp[0];
                words[base + 1] = words[prev + 1] ^ temp[1];
                words[base + 2] = words[prev + 2] ^ temp[2];
                words[base + 3] = words[prev + 3] ^ temp[3];
            }
            return { words: words, Nr: Nr };
        }

        // 全程使用列优先扁平数组：state[r + 4c]，与输入/轮密钥字节序一致
        function addRoundKey(state, words, round) {
            var b = round * 16;
            for (var i = 0; i < 16; i++) state[i] ^= words[b + i];
        }
        function subBytes(state, box) { for (var i = 0; i < 16; i++) state[i] = box[state[i]]; }
        function shiftRows(state) {
            var t;
            t = state[1]; state[1] = state[5]; state[5] = state[9]; state[9] = state[13]; state[13] = t;
            t = state[2]; var t2 = state[6]; state[2] = state[10]; state[6] = state[14]; state[10] = t; state[14] = t2;
            t = state[15]; state[15] = state[11]; state[11] = state[7]; state[7] = state[3]; state[3] = t;
        }
        function invShiftRows(state) {
            var t;
            t = state[13]; state[13] = state[9]; state[9] = state[5]; state[5] = state[1]; state[1] = t;
            t = state[2]; var t2 = state[6]; state[2] = state[10]; state[6] = state[14]; state[10] = t; state[14] = t2;
            t = state[3]; state[3] = state[7]; state[7] = state[11]; state[11] = state[15]; state[15] = t;
        }
        function gmulAES(a, b) {
            var p = 0;
            for (var i = 0; i < 8; i++) {
                if (b & 1) p ^= a;
                var hi = a & 0x80;
                a = (a << 1) & 0xff;
                if (hi) a ^= 0x1b;
                b >>= 1;
            }
            return p;
        }
        function mixColumns(state) {
            for (var c = 0; c < 4; c++) {
                var i = c * 4;
                var a0 = state[i], a1 = state[i + 1], a2 = state[i + 2], a3 = state[i + 3];
                state[i] = gmulAES(a0, 2) ^ gmulAES(a1, 3) ^ a2 ^ a3;
                state[i + 1] = a0 ^ gmulAES(a1, 2) ^ gmulAES(a2, 3) ^ a3;
                state[i + 2] = a0 ^ a1 ^ gmulAES(a2, 2) ^ gmulAES(a3, 3);
                state[i + 3] = gmulAES(a0, 3) ^ a1 ^ a2 ^ gmulAES(a3, 2);
            }
        }
        function invMixColumns(state) {
            for (var c = 0; c < 4; c++) {
                var i = c * 4;
                var a0 = state[i], a1 = state[i + 1], a2 = state[i + 2], a3 = state[i + 3];
                state[i] = gmulAES(a0, 14) ^ gmulAES(a1, 11) ^ gmulAES(a2, 13) ^ gmulAES(a3, 9);
                state[i + 1] = gmulAES(a0, 9) ^ gmulAES(a1, 14) ^ gmulAES(a2, 11) ^ gmulAES(a3, 13);
                state[i + 2] = gmulAES(a0, 13) ^ gmulAES(a1, 9) ^ gmulAES(a2, 14) ^ gmulAES(a3, 11);
                state[i + 3] = gmulAES(a0, 11) ^ gmulAES(a1, 13) ^ gmulAES(a2, 9) ^ gmulAES(a3, 14);
            }
        }
        function aesEncryptBlock(exp, block) {
            var state = block.slice();
            addRoundKey(state, exp.words, 0);
            for (var round = 1; round < exp.Nr; round++) {
                subBytes(state, SBOX); shiftRows(state); mixColumns(state); addRoundKey(state, exp.words, round);
            }
            subBytes(state, SBOX); shiftRows(state); addRoundKey(state, exp.words, exp.Nr);
            return state;
        }

        /* ---------------- GHASH / GCM (SP800-38D) ---------------- */
        function gmul128(X, Y) {
            var Z = new Uint8Array(16), V = Y.slice();
            for (var i = 0; i < 128; i++) {
                if ((X[i >> 3] >>> (7 - (i & 7))) & 1)
                    for (var j = 0; j < 16; j++) Z[j] ^= V[j];
                var lsb = V[15] & 1, carry = 0;
                for (var k = 0; k < 16; k++) {
                    var b = V[k] & 1;
                    V[k] = (V[k] >>> 1) | (carry << 7);
                    carry = b;
                }
                if (lsb) V[0] ^= 0xe1;
            }
            return Z;
        }
        function ghash(H, aad, data) {
            var Y = new Uint8Array(16), blk = new Uint8Array(16);
            function feed(buf) {
                for (var off = 0; off < buf.length; off += 16) {
                    var n = Math.min(16, buf.length - off);
                    blk.fill(0);
                    blk.set(buf.subarray(off, off + n));
                    for (var j = 0; j < 16; j++) Y[j] ^= blk[j];
                    Y = gmul128(Y, H);
                }
            }
            feed(aad);
            feed(data);
            // 长度块：[len(A) 64bit | len(C) 64bit]，大端、单位 bit
            var len = new Uint8Array(16);
            var ab = aad.length * 8, db = data.length * 8;
            len[4] = (ab >>> 24) & 255; len[5] = (ab >>> 16) & 255;
            len[6] = (ab >>> 8) & 255;  len[7] = ab & 255;
            len[12] = (db >>> 24) & 255; len[13] = (db >>> 16) & 255;
            len[14] = (db >>> 8) & 255;  len[15] = db & 255;
            for (var j = 0; j < 16; j++) Y[j] ^= len[j];
            Y = gmul128(Y, H);
            return Y;
        }
        function inc32(ctr) {
            for (var i = 15; i >= 12; i--) {
                ctr[i] = (ctr[i] + 1) & 255;
                if (ctr[i] !== 0) break;
            }
        }
        function gcmCrypt(exp, iv, aad, input, encrypting) {
            var H = aesEncryptBlock(exp, new Uint8Array(16));
            if (iv.length !== 12) {
                // NovaOS 固定使用 12 字节 IV；其他长度不支持，避免误用
                var ivErr = new Error("Only 96-bit IV supported"); ivErr.name = "NotSupportedError"; throw ivErr;
            }
            var J0 = new Uint8Array(16);
            J0.set(iv); J0[15] = 1;
            var bodyLen = encrypting ? input.length : input.length - 16;
            var tagOffset = bodyLen;
            var tag = input.subarray(tagOffset, tagOffset + 16);

            var ctr = J0.slice();
            var out = new Uint8Array(bodyLen);
            for (var off = 0; off < bodyLen; off += 16) {
                inc32(ctr);
                var ks = aesEncryptBlock(exp, ctr);
                var n = Math.min(16, bodyLen - off);
                for (var i = 0; i < n; i++) out[off + i] = input[off + i] ^ ks[i];
            }
            var eJ0 = aesEncryptBlock(exp, J0);
            var S = ghash(H, aad, encrypting ? out : input.subarray(0, bodyLen));
            var expected = new Uint8Array(16);
            for (i = 0; i < 16; i++) expected[i] = S[i] ^ eJ0[i];
            if (!encrypting) {
                var diff = 0;
                for (i = 0; i < 16; i++) diff |= expected[i] ^ tag[i];
                if (diff !== 0) {
                    var err = new Error("The operation failed for an operation-specific reason.");
                    err.name = "OperationError";
                    throw err;
                }
                return out.buffer;
            }
            var full = new Uint8Array(bodyLen + 16);
            full.set(out); full.set(expected, bodyLen);
            return full.buffer;
        }

        /* ---------------- SubtleCrypto-compatible surface ---------------- */
        function toBytes(x) {
            if (x instanceof Uint8Array) return x;
            if (x instanceof ArrayBuffer) return new Uint8Array(x);
            if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
            throw new TypeError("BufferSource required");
        }
        var derivedCache = {};
        function cacheKey(pw, salt, iter) {
            var h = sha256Bytes(pw);
            var s = "";
            for (var i = 0; i < h.length; i++) s += h[i].toString(16);
            return s + ":" + iter + ":" + toBytes(salt).length + ":" + toBytes(salt)[0];
        }

        return {
            importKey: function (format, keyData, algorithm, extractable, keyUsages) {
                return Promise.resolve().then(function () {
                    if (format !== "raw") { var e = new Error("NotSupported"); e.name = "NotSupportedError"; throw e; }
                    var raw = toBytes(keyData);
                    var name = (algorithm && algorithm.name) || "";
                    if (name === "PBKDF2") {
                        return { _poly: true, type: "raw", extractable: !!extractable,
                                 algorithm: { name: "PBKDF2" }, usages: keyUsages.slice(), k: raw };
                    }
                    if (name === "AES-GCM") {
                        if (raw.length !== 16 && raw.length !== 32) { var e2 = new Error("length"); e2.name = "OperationError"; throw e2; }
                        return { _poly: true, type: "secret", extractable: !!extractable,
                                 algorithm: { name: "AES-GCM", length: raw.length * 8 }, usages: keyUsages.slice(), k: raw };
                    }
                    var e3 = new Error("Unsupported algorithm " + name); e3.name = "NotSupportedError"; throw e3;
                });
            },
            deriveKey: function (alg, baseKey, derivedKeyType, extractable, keyUsages) {
                return Promise.resolve().then(function () {
                    if (!alg || alg.name !== "PBKDF2" || !derivedKeyType || derivedKeyType.name !== "AES-GCM") {
                        var e = new Error("NotSupported"); e.name = "NotSupportedError"; throw e;
                    }
                    if (alg.hash !== "SHA-256") { var e2 = new Error("Only SHA-256"); e2.name = "NotSupportedError"; throw e2; }
                    var salt = toBytes(alg.salt);
                    var ck = cacheKey(baseKey.k, salt, alg.iterations);
                    var dk = derivedCache[ck];
                    if (!dk) {
                        dk = pbkdf2Sha256(baseKey.k, salt, alg.iterations, derivedKeyType.length / 8);
                        derivedCache[ck] = dk;
                    }
                    return { _poly: true, type: "secret", extractable: !!extractable,
                             algorithm: { name: "AES-GCM", length: derivedKeyType.length },
                             usages: keyUsages.slice(), k: dk };
                });
            },
            encrypt: function (params, key, data) {
                return Promise.resolve().then(function () {
                    if (!params || params.name !== "AES-GCM") { var e = new Error("NotSupported"); e.name = "NotSupportedError"; throw e; }
                    var exp = keyExpansion(key.k);
                    var iv = toBytes(params.iv);
                    var aad = params.additionalData ? toBytes(params.additionalData) : new Uint8Array(0);
                    return gcmCrypt(exp, iv, aad, toBytes(data), true);
                });
            },
            decrypt: function (params, key, data) {
                return Promise.resolve().then(function () {
                    if (!params || params.name !== "AES-GCM") { var e = new Error("NotSupported"); e.name = "NotSupportedError"; throw e; }
                    var exp = keyExpansion(key.k);
                    var iv = toBytes(params.iv);
                    var aad = params.additionalData ? toBytes(params.additionalData) : new Uint8Array(0);
                    return gcmCrypt(exp, iv, aad, toBytes(data), false);
                });
            },
            /* debug/self-test hooks */
            __dbg: {
                sha256: sha256Bytes,
                hmac: hmacSha256,
                pbkdf2: pbkdf2Sha256,
                aes: aesEncryptBlock,
                expand: keyExpansion,
                ghash: ghash,
                gmul: gmul128,
                sub: function (s) { subBytes(s, SBOX); return s; },
                shifts: function (s) { shiftRows(s); return s; },
                mix: function (s) { mixColumns(s); return s; },
                ark: function (s, w, r) { addRoundKey(s, w, r); return s; }
            }
        };
    }

    var c = global.crypto || (global.crypto = {});
    var installed = false;
    if (!c.subtle) {
        c.subtle = makeSubtle();
        installed = true;
    }
    // diagnostic marker + factory for known-answer self-tests
    global.__novaCryptoPoly = { installed: installed, native: !installed, make: makeSubtle };

})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this));
