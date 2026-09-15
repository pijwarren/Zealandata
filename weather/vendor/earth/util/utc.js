/**
 * utc: utilities for working with datetimes.
 *
 * CONSIDER: a datetime starts at year, a duration is a partial datetime. So is {year: 2015} a datetime or a duration?
 * How about {year: 2016, month: 2, day: 14}?
 */

// CONSIDER: parsing dates using the Date constructor is not recommended.

import {pad} from "./strings.js";
import {DAY, HOUR, MINUTE, SECOND} from "./consts.js";

const all = ["year", "month", "day", "hour", "minute", "second", "milli"];

/**
 * @param {Date|string|number} date a Date object, or parsable date string (Note: "YYYY-MM-DDThh:mm:ss" and its
 *        prefixes are interpreted in UTC zone.)
 * @returns {Date} a Date object
 */
function asDate(date) {
    date = date ?? "";
    if (typeof date === "string" || +date === date) {
        date = new Date(date);
    }
    return date;
}

/**
 * @param {Date|string|number} date a Date object, or parsable date string (Note: "YYYY-MM-DDThh:mm:ss" and its
 *        prefixes are interpreted in UTC zone.)
 * @returns {Object} all UTC parts of the date: "year", "month", "day", "hour", "minute", "second", "milli"
 */
export function parts(date) {
    date = asDate(date);
    return {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
        hour: date.getUTCHours(),
        minute: date.getUTCMinutes(),
        second: date.getUTCSeconds(),
        milli: date.getUTCMilliseconds(),
    };
}

/**
 * @param {Date|string|number} date a Date object, or parsable date string (Note: "YYYY-MM-DDThh:mm:ss" and its
 *        prefixes are interpreted in UTC zone.)
 * @returns {Object} all Local parts of the date: "year", "month", "day", "hour", "minute", "second", "milli"
 */
export function localParts(date) {
    date = asDate(date);
    return {
        year: date.getFullYear(),
        month: date.getMonth() + 1,
        day: date.getDate(),
        hour: date.getHours(),
        minute: date.getMinutes(),
        second: date.getSeconds(),
        milli: date.getMilliseconds(),
    };
}

/**
 * @param {Object} parts the UTC date parts.
 * @returns {Date} the Date representation of the specified parts.
 */
export function date(parts) {
    const year = +(parts.year ?? 0);
    const result = new Date(Date.UTC(
        year,
        (parts.month ?? 1) - 1,
        parts.day ?? 1,
        parts.hour ?? 0,
        parts.minute ?? 0,
        parts.second ?? 0,
        parts.milli ?? 0,
    ));
    if (+result === +result && 0 <= year && year <= 99) {
        result.setUTCFullYear(year);  // fix issue that two digit years are mapped to 1900-1999
    }
    return result;
}

export function localDate(parts) {
    const year = +(parts.year ?? 0);
    const result = new Date(
        year,
        (parts.month ?? 1) - 1,
        parts.day ?? 1,
        parts.hour ?? 0,
        parts.minute ?? 0,
        parts.second ?? 0,
        parts.milli ?? 0,
    );
    if (+result === +result && 0 <= year && year <= 99) {
        result.setFullYear(year);  // fix issue that two digit years are mapped to 1900-1999
    }
    return result;
}

export function toLocalParts(parts) {
    return localParts(date(parts));
}

export function toUTCParts(_parts) {
    return parts(localDate(_parts));
}

/**
 * Adjusts UTC date parts so that they represent an actual date. Parts that overflow, like {hour: 36}, are
 * adjusted to their proper range by carrying-over to the next larger part. Missing parts are added.
 *
 * @param parts the UTC date parts to normalize.
 * @returns {{year: number, month: number, day: number, hour: number, minute: number, second: number, milli:
 *     number}} all UTC parts adjusted to represent an actual date.
 */
export function normalize(parts) {
    return _parts(date(parts));
}
const _parts = parts;

/**
 * @param {Object} parts the UTC date parts.
 * @param {Object} delta the parts to add. For example: {hour: 1, minute: 30}.
 * @returns {{year: number, month: number, day: number, hour: number, minute: number, second: number, milli:
 *     number}} all UTC parts with the delta added.
 */
export function add(parts, delta) {
    // CONSIDER: it's annoying that the result is not normalized when adding/subtracting from full dates.
    const result = Object.assign({}, parts);
    all.filter(key => key in delta).forEach(key => {
        result[key] = +(result[key] ?? 0) + (+delta[key]);
    });
    return result;
}

/**
 * @returns {number} standard comparator result. Both arguments are converted to Unix millis then compared.
 *          Invalid dates are smaller/earlier than all valid dates.
 */
export function compare(aParts, bParts) {
    let a = date(aParts).getTime();
    if (isNaN(a)) {
        a = -Infinity;
    }
    let b = date(bParts).getTime();
    if (isNaN(b)) {
        b = -Infinity;
    }
    return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * @param {Object} parts the UTC date parts.
 * @param {string} format the format specification. Example: "{YYYY}-{MM}-{DD}T{hh}:{mm}:{ss}.{SSS}"
 * @returns {string} the formatted date.
 */
export function print(parts, format) {
    // CONSIDER: possible to use tagged string templates for this?
    const builder = [];
    for (let i = 0; i < format.length; i++) {
        let c = format[i];
        if (c !== "{") {
            builder.push(c);
            continue;
        }
        let spec = "";
        for (i++; i < format.length; i++) {
            c = format[i];
            if (c !== "}") {
                spec += c;
                continue;
            }
            let value = NaN;
            switch (spec[0]) {
                case "Y": value = +parts.year; break;
                case "M": value = +parts.month; break;
                case "D": value = +parts.day; break;
                case "h": value = +parts.hour; break;
                case "m": value = +parts.minute; break;
                case "s": value = +parts.second; break;
                case "S": value = +parts.milli; break;
            }
            if (value === value) {
                builder.push(pad(value, spec.length));
            } else {
                builder.push("{", spec, "}");
            }
            break;
        }
    }
    return builder.join("");
}

export function parse(s, format, groups) {
    const parts = {};
    function assign(key, value) { if (value === value) { parts[key] = value; } }

    groups = groups ?? {year: 1, month: 2, day: 3, hour: 4, minute: 5, second: 6, milli: 7};
    const match = format.exec(s);
    if (match) {
        assign("year", +match[groups.year]);
        assign("month", +match[groups.month]);
        assign("day", +match[groups.day]);
        assign("hour", +match[groups.hour]);
        assign("minute", +match[groups.minute]);
        assign("second", +match[groups.second]);
        assign("milli", +match[groups.milli]);
    }
    return parts;
}

export function printISO(parts) {
    return date(parts).toISOString();
}

export function largest(parts) {
    for (let i = 0; i < all.length; i++) {
        if (all[i] in parts) {
            return all[i];
        }
    }
    return undefined;
}

/**
 * Find the most precise part included in the specified date parts.
 * @param parts
 * @returns {array} two element array of [part name, precedence], or [] if there are no fields.
 */
export function precision(parts) {
    for (let i = all.length - 1; i >= 0; i--) {
        if (all[i] in parts) {
            return [all[i], i];
        }
    }
    return [];
}

/**
 * Chop off all date parts smaller than the specified parts.
 *
 * @param part the part at which to chop.
 * @param dt the source date parts.
 * @returns {Object} new date parts containing all components of dt up to part.
 */
export function chop(part, dt) {
    const result = {};
    for (let i = 0; i < all.length; i++) {
        const field = all[i];
        if (field in dt) {
            result[field] = dt[field];
        }
        if (field === part) {
            break;
        }
    }
    return result;
}

/**
 * Carry-over any overflowing field to the next biggest.
 *     {hour: 2, minute: 65}  ->  {hour: 3, minute: 5}
 *
 * Overflowing stops at the largest defined field, up to "day". For example:
 *              {minute: 65}  ->  {minute: 65}
 *     {hour: 0, minute: 65}  ->  {hour: 1, minute: 5}
 *
 * @param {Object} parts the UTC date parts.
 * @returns {Object} new UTC date parts where any overflow has been carried over to the next biggest field.
 */
export function carry(parts) {
    // CONSIDER: normalize and carry are pretty similar, except that carry is meant for durations (stops at "day").

    const result = {};
    if (parts.year !== undefined) result.year = parts.year;
    if (parts.month !== undefined) result.month = parts.month;

    const stop = largest(parts);
    let day = parts.day;
    let hour = parts.hour;
    let minute = parts.minute;
    let second = parts.second;
    let milli = parts.milli;

    if (stop !== "milli") {
        if (milli >= 1000) {
            second = (second ?? 0) + Math.floor(milli / 1000);
            milli %= 1000;
        }
        if (stop !== "second") {
            if (second >= 60) {
                minute = (minute ?? 0) + Math.floor(second / 60);
                second %= 60;
            }
            if (stop !== "minute") {
                if (minute >= 60) {
                    hour = (hour ?? 0) + Math.floor(minute / 60);
                    minute %= 60;
                }
                if (stop !== "hour") {
                    if (hour >= 24) {
                        day = (day ?? 0) + Math.floor(hour / 24);
                        hour %= 24;
                    }
                }
            }
        }
    }

    if (day !== undefined) result.day = day;
    if (hour !== undefined) result.hour = hour;
    if (minute !== undefined) result.minute = minute;
    if (second !== undefined) result.second = second;
    if (milli !== undefined) result.milli = milli;

    return result;
}

/**
 * @param parts the input datetime.
 * @returns {Object} a datetime with all parts specified, filled in with zero when undefined.
 */
function fill(parts) {
    return {
        year: parts.year ?? 0,
        month: parts.month ?? 0,
        day: parts.day ?? 0,
        hour: parts.hour ?? 0,
        minute: parts.minute ?? 0,
        second: parts.second ?? 0,
        milli: parts.milli ?? 0,
    };
}

/**
 * Accumulates the total duration of time into one part specified by key. Standard durations are used. Years and
 * months are ignored because they convert to a variable number of days.
 *
 *       "hour", {hour: 2, minute: 65}  ->  {hour: 3}
 *     "minute", {hour: 2, minute: 65}  ->  {minute: 185}
 *     "second", {hour: 2, minute: 65}  ->  {second: 11100}
 *
 * @param {string} key the part to accumulate time into.
 * @param {Object} parts the input duration.
 * @returns {Object} datetime with one part, {key: }, where all the time has been accumulated into it.
 */
export function accumulate(key, parts) {
    const smoothed = carry(fill(parts));
    let accum = smoothed.day;
    if (key === "day") {
        return {day: accum};
    }
    accum = accum * 24 + smoothed.hour;
    if (key === "hour") {
        return {hour: accum};
    }
    accum = accum * 60 + smoothed.minute;
    if (key === "minute") {
        return {minute: accum};
    }
    accum = accum * 60 + smoothed.second;
    if (key === "second") {
        return {second: accum};
    }
    accum = accum * 1000 + smoothed.milli;
    if (key === "milli") {
        return {milli: accum};
    }
    const result = {};
    result[key] = undefined;
    return result;
}

/**
 * @param start the starting UTC parts, inclusive
 * @param end the ending UTC parts, inclusive
 * @param delta the UTC parts
 * @returns {Array} a range of UTC parts separated by delta
 */
export function range(start, end, delta) {
    const results = [];
    for (let i = start; compare(i, end) <= 0; i = add(i, delta)) {
        results.push(carry(i));
    }
    return results;
}

/**
 * @param {Object} dt the datetime.
 * @returns {number} the ordinal number of days from Jan 1 of the input year, starting at 1.
 */
export function dayOfYear(dt) {
    const d1 = date(dt), d0 = date({year: d1.getUTCFullYear()});
    return Math.floor((d1 - d0) / DAY) + 1;  // No daylight savings in UTC.
}

export function floor(parts, alignment) {
    const {day = 0, hour = 0, minute = 0, second = 0, milli = 0} = alignment;
    const alignmentMillis = day * DAY + hour * HOUR + minute * MINUTE + second * SECOND + milli;
    const timestamp = +date(parts);
    const aligned = Math.floor(timestamp / alignmentMillis) * alignmentMillis;
    return _parts(aligned);
}

export function ceil(parts, alignment) {
    const {day = 0, hour = 0, minute = 0, second = 0, milli = 0} = alignment;
    const alignmentMillis = day * DAY + hour * HOUR + minute * MINUTE + second * SECOND + milli;
    const timestamp = +date(parts);
    const aligned = Math.ceil(timestamp / alignmentMillis) * alignmentMillis;
    return _parts(aligned);
}
