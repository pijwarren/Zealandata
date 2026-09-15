/**
 * decoder - methods for decoding weather data
 *
 * Copyright (c) 2021 Cameron Beccario
 */

import {clamp} from "../util/math.js";
import {decodeUTF8} from "./utf8.js";

/*
function blockView(data, cols, rows) {
    const area = cols * rows;
    return {
        x: function(i) {
            return i % cols;
        },
        y: function(i) {
            return Math.floor(i / cols) % rows;
        },
        z: function(i) {
            return Math.floor(i / area);
        },
        valueAt: function(x, y, z) {
            if (0 <= x && x < cols) {
                if (0 <= y && y < rows) {
                    const i = z * area + y * cols + x;
                    if (0 <= z && i < data.length) {
                        return data[i];
                    }
                }
            }
            return Number.NaN;
        }
    };
}
*/

export function varpackDecode(values, bytes) {
    // decodes var ints into the destination "values" array.
    //    if dest is Float64Array, then ints up to 2^53-1 can be successfully decoded
    //    if dest is Float32Array, then ints up to 2^24-1 can be successfully decoded

    let i = 0, j = 0;
    while (i < bytes.length) {
        let b = bytes[i++];
        if (b < 128) {
            b = b << 25 >> 25;
        } else {
            switch (b >> 4) {
                case 0x8:
                case 0x9:
                case 0xa:
                case 0xb:
                    b = (b << 26 >> 18) | bytes[i++];
                    break;
                case 0xc:
                case 0xd:
                    b = (b << 27 >> 11) | bytes[i++] << 8 | bytes[i++];
                    break;
                case 0xe:
                    b = (b << 28 >> 4) | bytes[i++] << 16 | bytes[i++] << 8 | bytes[i++];
                    break;
                case 0xf:
                    if (b === 255) {
                        for (let run = 1 + bytes[i++]; run > 0; run--) {
                            values[j++] = NaN;
                        }
                        continue;
                    } else {
                        switch (b & 0x07) {
                            case 0x0:
                            case 0x1:
                            case 0x2:
                            case 0x3:
                            case 0x4:
                            case 0x5:
                            case 0x6:
                            case 0x7:
                                b = bytes[i++] << 24 | bytes[i++] << 16 | bytes[i++] << 8 | bytes[i++];
                                break;
                            case 0x8:
                            case 0x9:
                            case 0xa:
                            case 0xb:

                                // break;
                            default: throw new Error("NYI");
                        }
                    }
                    break;
            }
        }
        values[j++] = b;
    }
    return values;
}

export function undeltaPlane(values, cols, rows, grids) {
    let x, y, z, i, j, k, p;

    for (z = 0; z < grids; z++) {
        k = z * cols * rows;
        for (x = 1; x < cols; x++) {
            i = k + x;
            p = values[i - 1];
            values[i] += (p === p ? p : 0);
        }
        for (y = 1; y < rows; y++) {
            j = k + y * cols;
            p = values[j - cols];
            values[j] += (p === p ? p : 0);
            for (x = 1; x < cols; x++) {
                i = j + x;
                const a = values[i - 1];
                const b = values[i - cols];
                const c = values[i - cols - 1];
                p = a + b - c;
                values[i] += (p === p ? p : a === a ? a : b === b ? b : c === c ? c : 0);
            }
        }
    }

    return values;
}

export function dequantize(values, scaleFactor) {
    for (let i = 0; i < values.length; i++) {
        values[i] /= scaleFactor;
    }
    return values;
}

/**
 * Decodes a quantized delta-plane varpack array of floats.
 *
 * @param {Uint8Array} bytes the encoded values as an array of bytes
 * @param cols size of the x dimension
 * @param rows size of the y dimension
 * @param grids size of the z dimension
 * @param scaleFactor number of decimal digits after (+) or before (-) the decimal point to retain
 * @returns {Float32Array} the decoded values
 */
export function decodePpak(bytes, cols, rows, grids, scaleFactor) {
    const values = new Float32Array(cols * rows * grids);
    varpackDecode(values, bytes);
    undeltaPlane(values, cols, rows, grids);
    dequantize(values, scaleFactor);
    return values;
}

/**
 * Decodes a ppak block from a buffer having the format:
 * <pre>
 *       int32   int32   int32      float32     byte[]
 *     [ cols ][ rows ][ grids ][ scaleFactor ][ data ]
 *      ----------------------------------------------
 *                        length
 * </pre>
 * All multi-byte values are BE. The number of resulting values is cols * rows * grids.
 *
 * @param {string} type the ppak type/version string
 * @param {ArrayBuffer} buffer the buffer
 * @param offset buffer byte offset
 * @param length the byte length of the block
 * @returns {{metadata: *, values: Float32Array}} the decoded values
 */
export function decodePpakBlock(type, buffer, offset, length) {
    const view = new DataView(buffer, offset, length);
    const bytes = new Uint8Array(buffer, offset + 16, length - 16);
    const cols = view.getInt32(0);
    const rows = view.getInt32(4);
    const grids = view.getInt32(8);
    const scaleFactor = Math.pow(10, view.getFloat32(12));
    return {
        metadata: {type, cols, rows, grids, scaleFactor},
        values: decodePpak(bytes, cols, rows, grids, scaleFactor),
    };
}

function arrayFromType(type, size) {
    switch (type) {
        // case 1:  return new Int8Array(size);
        // case 2:  return new Uint8Array(size);
        // case 3:  return new Uint8ClampedArray(size);
        // case 4:  return new Int16Array(size);
        // case 5:  return new Uint16Array(size);
        // case 6:  return new Int32Array(size);
        // case 7:  return new Uint32Array(size);
        case 8:  return new Float32Array(size);
        case 9:  return new Float64Array(size);
        // case 10: return new BigInt64Array(size);
        // case 11: return new BigUint64Array(size);
        default:
            throw new Error(`unknown array type: ${type}`);
    }
}

export function decodeQpak(bytes, type, size, scaleFactor) {
    const values = arrayFromType(type, size);
    varpackDecode(values, bytes);
    decodeDelta(values, values);
    dequantize(values, scaleFactor);
    return values;
}

/*
 * Decodes a qpak block having the format:
 *                              meta
 *                ------------------------------------
 *                int32   uint8   int32     float64     byte[]
 *     [ "qpak" ][ len ][ type ][ size ][ scaleFactor ][ data ]
 *                       -------------------------------------
 *                                    len
 */
export function decodeQpakBlock(buffer, offset, length) {
    const view = new DataView(buffer, offset, length);
    const bytes = new Uint8Array(buffer, offset + 13, length - 13);
    const type = view.getUint8(0);
    const size = view.getInt32(1);
    const scaleFactor = view.getFloat64(5);
    return {
        metadata: {type: "qpak", scaleFactor},
        values: decodeQpak(bytes, type, size, scaleFactor),
    };
}

/**
 * Earth-Pack (EPAK) container format:
 * <pre>
 *     head  := "head" (BE alpha-4) length (BE int) json (UTF-8 JSON string)
 *     block :=  type  (BE alpha-4) length (BE int) data (byte[])
 *     tail  := "tail"
 *     file  :=  head [block]* tail
 *
 *     head                                  block                           tail
 *     ------------------------------------  ------------------------------  ------
 *    ["head"][0x00000003][0x10, 0x11, 0x12]["ppak"][0x00000002][0xff, 0xff]["tail"]
 *             ----------  ----------------  ------  ----------  ----------
 *               length          json         type     length       data
 * </pre>
 *
 * @param {ArrayBuffer} buffer the buffer to decode
 * @param {Object} [options] decoding options: {headerOnly: boolean}
 * @returns {{header: *, blocks: Array, metadata: Array}} the decoded values
 */
export function decodeEpak(buffer, options) {
    const headerOnly = options?.headerOnly === true;
    let i = 0;
    const view = new DataView(buffer);

    const head = decodeUTF8(new Uint8Array(buffer, i, 4));
    i += 4;
    if (head !== "head") {
        throw new Error("expected 'head' but found '" + head + "'");
    }

    let length = view.getInt32(i);
    i += 4;
    const header = JSON.parse(decodeUTF8(new Uint8Array(buffer, i, length)));
    i += length;

    let block;
    const blocks = [];
    const metadata = [];
    let type;
    while (!headerOnly && (type = decodeUTF8(new Uint8Array(buffer, i, 4))) !== "tail") {
        i += 4;
        length = view.getInt32(i);
        i += 4;
        switch (type) {
            case "ppak":
                block = decodePpakBlock(type, buffer, i, length);
                break;
            case "qpak":
                block = decodeQpakBlock(buffer, i, length);
                break;
            default:
                throw new Error("unknown block type: " + type);
        }
        blocks.push(block.values);
        metadata.push(block.metadata);
        i += length;
    }

    return {header: header, blocks: blocks, metadata: metadata};
}

/**
 * Decode an array having "Packed Delta RLE" encoding. This has three steps:
 *
 *    1. Unroll runs:
 *        Replace every tuple element Si := [v, X] with the run of elements it represents: v0, .., v{X-1}
 *
 *    2. Convert running deltas into absolute values:
 *        [D0, .., D{N-1}]  =>  [T0, .., T{N-1}] where Ti := T{i-1} + Di
 *                                                     T0 := D0
 *                                                     Ti == Di when T{i-1} is null or NaN
 *
 *    3. Unpack each value:
 *        [T0, .., T{N-1}]  =>  [R0, .., R{N-1}] where Ri := Ti * scaleFactor + addOffset
 *
 * null is replaced with NaN.
 *
 * Example:
 *     [1,[2,5],3,[null,2],4]  ->  [1,2,2,2,2,2,3,null,null,4]  ->  [1,3,5,7,9,11,14,NaN,NaN,4]
 *
 * @param {array} data the encoded array of data.
 * @param {number} scaleFactor the amount to multiply each data point by.
 * @param {number} addOffset the amount to add to each data point.
 * @param {number} length the expected length of the decoded data array.
 * @returns {Float32Array} the array of decoded data.
 */
export function decodePackedDeltaRle(data, scaleFactor, addOffset, length) {

    const result = new Float32Array(length);
    let j = 0;
    for (let i = 0, prev = 0; i < data.length && j < length; i++) {
        const raw = data[i];
        const isRun = Array.isArray(raw);
        const val = isRun ? raw[0] : raw;
        const stop = isRun ? clamp(+raw[1] + j, j, length) : j + 1;  // guard against malicious run lengths
        const v = +val;
        if (val === null || v !== v) {
            if (!(j < stop)) {
                continue;  // ignore zero or NaN length runs
            }
            while (j < stop) {
                result[j++] = NaN;
            }
            prev = 0;
        } else {
            while (j < stop) {
                result[j++] = (prev = (prev + v)) * scaleFactor + addOffset;
            }
        }
    }

    // Fill remaining space in the result array, if any.
    while (j < length) {
        result[j++] = NaN;
    }

    return result;
}

/**
 * Convert scaled numbers to their original values, where null (missing) elements are converted to NaN.
 *
 * @param {Array} data
 * @param {number} scaleFactor
 * @returns {Float32Array} the data as a float array, where NaN represents missing.
 */
export function decodeArray(data, scaleFactor) {
    const result = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) {
        result[i] = (data[i] ?? NaN) / scaleFactor;
    }
    return result;
}

/**
 * Convert scaled deltas to their original values, where:
 *    result[j] := (result[j-1] + data[i]) / scaleFactor, data[-1] == result[-1] == 0, i == j == 0 initially, and
 *    result[j...j+n] := NaN where data[i] == null and n == data[i+1] (run length encoded missing values)
 *
 * Example:
 *    data:   [32, 0, 1, null, 2, 42]
 *    result: [3.2, 3.2, 3.3, NaN, NaN, NaN, 4.2] when scaleFactor == 10
 *
 * @param {Array} data encoded values.
 * @param {number} scaleFactor encoded values scaled by this amount.
 * @param {number} length the expected number of decoded values.
 * @returns {Float32Array} the decoded values, where NaN represents missing.
 */
export function decodeRunDelta(data, scaleFactor, length) {
    const result = new Float32Array(length);
    let i = 0;
    let j = 0;
    let prev = 0;
    while (i < data.length) {
        const v = data[i++];
        if (v === null) {  // UNDONE: what about v is undef or NaN? should handle that, too...
            for (let run = Math.min(data[i++] + 1, length); run > 0; run--) {
                result[j++] = NaN;
            }
            prev = 0;
        } else {
            result[j++] = (prev = prev + v) / scaleFactor;
        }
    }
    return result;
}

export function decodeDelta(src, dest) {
    for (let prev = 0, i = 0; i < src.length; i++) {
        dest[i] = prev = prev + src[i];
    }
}
