
/**
 * Decodes a UTF8 string from an array of bytes.
 *
 * @param {Uint8Array} bytes an array of bytes
 * @returns {String} the decoded String
 */
export function decodeUTF8(bytes) {
    // CONSIDER: just use TextDecoder when adoption is higher.
    // const decoder = new TextDecoder("utf-8");
    // return decoder.decode(bytes);

    const charCodes = [];
    for (let i = 0; i < bytes.length;) {
        let b = bytes[i++];
        switch (b >> 4) {
            case 0xc:
            case 0xd:
                b = (b & 0x1f) << 6 | bytes[i++] & 0x3f;
                break;
            case 0xe:
                b = (b & 0x0f) << 12 | (bytes[i++] & 0x3f) << 6 | bytes[i++] & 0x3f;
                break;
            default:
            // use value as-is
        }
        charCodes.push(b);
    }
    return String.fromCharCode.apply(null, charCodes);
}
