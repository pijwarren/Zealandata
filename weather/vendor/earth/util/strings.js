
import {floorMod} from "./math.js";

/**
 * Returns the string representation of the specified value padded with leading characters to make it at least
 * "width" length.
 *
 * @param {string|*} x the value to pad
 * @param {number} width the desired minimum width of the resulting string
 * @param {string} [char] the character to use for padding, default is "0"
 * @returns {string} the padded string
 */
export function pad(x, width, char = "0") {
    const s = String(x);
    const i = Math.max(width - s.length, 0);
    return new Array(i + 1).join(char) + s;
}

/**
 * @returns {string} the specified string with the first letter capitalized.
 */
export function capitalize(s) {
    return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.substr(1);
}

/**
 * https://en.wikipedia.org/wiki/Decimal_degrees
 *
 * @param {number[]} coords [λ, φ]
 * @param {number?} n the number of digits past the decimal point to show
 * @returns {string} the coords formatted as "DDD.dd° N, DD.dd° E", or undefined if the coords are not numbers
 */
export function formatAsDecimalDegrees(coords, n = 2) {
    const λ = floorMod(+coords?.[0] + 180, 360) - 180;  // wrap to [-180, 180)
    const φ = +coords?.[1];
    return λ === λ && φ === φ ?
        `${Math.abs(φ).toFixed(n)}° ${φ >= 0 ? "N" : "S"}, ${Math.abs(λ).toFixed(n)}° ${λ >= 0 ? "E" : "W"}` :
        undefined;
}
