/* NovaOS crypto worker (extracted from readwrite.js blob template).
   Loads the SubtleCrypto polyfill so it works on non-secure HTTP origins. */
try { importScripts('cryptopoly.js'); } catch (e) { }

function bufferToBase64(buffer) {
    return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}
async function encryptData(key, data) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    let encoded;

    if (typeof data === 'string') {
        encoded = new TextEncoder().encode(data);
    } else if (data instanceof Blob) {
        encoded = new Uint8Array(await data.arrayBuffer());
    } else if (data instanceof Uint8Array || ArrayBuffer.isView(data)) {
        encoded = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else {
        throw new Error("Unsupported data type for encryption");
    }

    const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        encoded
    );

    return {
        iv: iv.buffer,
        data: encrypted
    };
}

async function decryptData(key, encryptedData) {
    try {
        const iv = new Uint8Array(encryptedData.iv);
        const data = encryptedData.data;

        const decrypted = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv },
            key,
            data
        );

        try {
            return new TextDecoder().decode(decrypted);
        } catch {
            return new Uint8Array(decrypted);
        }
    } catch (error) {
        console.error("Decryption failed:", error);
        throw new Error('Incorrect password or corrupted data');
    }
}

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    bytes.forEach(b => binary += String.fromCharCode(b));
    return btoa(binary);
}

function base64ToArrayBuffer(base64) {
    try {
        const binary = atob(base64);
        const len = binary.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes.buffer;
    } catch (e) {
        console.error("Invalid base64 input:", base64);
        throw e;
    }
}

self.addEventListener('message', async (e) => {
    const { type, content, key } = e.data;
    try {
        let result;
        switch (type) {
            case 'encrypt':
                result = await encryptData(key, content);
                break;
            case 'decrypt':
                result = await decryptData(key, content);
                break;
            default:
                throw new Error('Unknown operation');
        }
        self.postMessage({ success: true, result },
            result && result.data instanceof ArrayBuffer && result.iv instanceof ArrayBuffer
                ? [result.data, result.iv]
                : []
        );
    } catch (err) {
        self.postMessage({ success: false, error: err.message });
    }
});
