
import * as _ from "../lib/underscore.js";
import {NIL} from "./consts.js";

export function isArrayLike(obj) {
    if (Array.isArray(obj)) return true;
    if (typeof obj !== "object" || !obj) return false;
    const length = obj.length;
    return typeof length === "number" && length >= 0;
}

/**
 * @param {Array|Uint8Array|Float32Array} a any array-like object
 * @param {Array|Uint8Array|Float32Array} b any array-like object
 * @returns {boolean} true if both arrays are strictly equal (using ===) while recursing down nested arrays.
 */
export function arraysEq(a, b) {
    for (let i = 0; i < a.length; i++) {
        const s = a[i], t = b[i];
        if (s === t) {
            continue;  // exactly equal
        }
        if (s !== s && t !== t) {
            continue;  // both are NaN
        }
        if (isArrayLike(s) && arraysEq(s, t)) {
            continue;  // nested arrays are equal
        }
        return false;
    }
    return a.length === b.length;
}

/**
 * @param {Float32Array} a [a0, a1, a2, ...]
 * @param {Float32Array} b [b0, b1, b2, ...]
 * @returns {Float32Array} [a0, b0, a1, b1, a2, b2, ...]
 */
export function merge(a, b) {
    const result = new Float32Array(a.length * 2);
    for (let i = 0; i < a.length; i++) {
        const j = i * 2;
        result[j] = a[i];
        result[j + 1] = b[i];
    }
    return result;
}

// /**
//  * @param {Int8Array|Int16Array|Int32Array} array any TypedArray
//  * @param {Number} samples the number of samples to compute the hash code
//  * @returns {Number} the hash code
//  */
// function _arrayHashCode(array, samples) {
//     const result = new Int32Array([array.byteLength]);
//     const step = Math.max(array.length / samples, 1);
//     for (let i = 0; i < array.length; i += step) {
//         result[0] = 31 * result[0] + array[Math.floor(i)];
//     }
//     return result[0];
// }
//
// /**
//  * Constructs a hash code from _some_ elements of an array. Trades collision avoidance for performance.
//  * @param {Float32Array|Uint8Array} array any TypedArray
//  * @param {Number} [samples] the number of samples to compute the hash code with. (default: all)
//  * @returns {Number} the hash code
//  */
// export function arrayHashCode(array, samples = Infinity) {
//     let data;
//     switch (array.byteLength % 4) {
//         case 0:
//             data = new Int32Array(array.buffer);
//             break;
//         case 2:
//             data = new Int16Array(array.buffer);
//             break;
//         default:
//             data = new Int8Array(array.buffer);
//             break;
//     }
//     return _arrayHashCode(data, samples);
// }

function _flatten(array, target) {
    for (let i = 0; i < array.length; i++) {
        const e = array[i];
        if (isArrayLike(e)) {
            _flatten(e, target);
        } else {
            target.push(e);
        }
    }
    return target;
}

export function flatten(array) {
    // CONSIDER: replace with Array.flat when widely available
    return isArrayLike(array) ? _flatten(array, []) : undefined;
}

export function copyTypedArray(target, source) {
    // Some browsers do not support TypedArray.prototype.set, like Android.
    if (_.isFunction(target.set)) {
        target.set(source);
    } else {
        for (let i = 0; i < source.length; i++) {
            target[i] = source[i];
        }
    }
}

/**
 * @param {Float32Array} source
 * @returns {Float32Array}
 */
export function mapNaNtoNIL(source) {
    // CONSIDER: wasm?
    const target = new Float32Array(source.length);
    for (let i = 0; i < source.length; i++) {
        const v = source[i];
        target[i] = isNaN(v) ? NIL : v;
    }
    return target;
}

/**
 * @param {[]} arr
 * @returns {[]} a new array containing only unique values from the original
 */
export function uniq(arr) {
    return [...new Set(arr)];
}

/**
 * @param {array} arr array to resize
 * @param {number} newLength the new length of the array
 * @param [fillValue] fill value for new elements, if any (default: undefined)
 * @returns {array} the modified original array
 */
export function resize(arr, newLength, fillValue) {
    const oldLength = arr.length;
    arr.length = newLength;
    return arr.fill(fillValue, oldLength);
}
