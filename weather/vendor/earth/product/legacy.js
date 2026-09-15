
import * as utc from "../util/utc.js";

/**
 * Makes an old-style grib2json file look like an epak file
 *
 * @param {Array} records the grib2json payload.
 * @param {string[]} varNames the variable names associated with the grib2json records.
 * @param {string[]?} dimensions the dimensions to inject the header, or ["time", "lat", "lon"] by default.
 * @returns {Object} an epak-like structure.
 */
export function munge(records, varNames, dimensions) {

    const header = records[0].header;
    const validTime = utc.add(utc.parts(header.refTime), {hour: header.forecastTime});
    const variables = {
        time: { data: [utc.printISO(validTime)] },
        lat: { sequence: { start: header.la1, delta: -header.dy, size: header.ny } },
        lon: { sequence: { start: header.lo1, delta: header.dx, size: header.nx } },
    };
    const blocks = [];

    varNames.forEach((key, i) => {
        variables[key] = { dimensions: dimensions || ["time", "lat", "lon"], data: {block: i} };
        blocks[i] = new Float32Array(records[i].data);
    });

    return {
        header: { variables: variables },
        blocks: blocks,
    };

}

/**
 * Some early epaks did not use binary blocks, so convert them into the expected form.
 */
export function blockify(epak, selector) {
    const variables = epak.variables;
    const blocks = [];

    Object.keys(variables).forEach(key => {
        if (selector.test(key)) {
            const v = variables[key];
            blocks.push(new Float32Array(v.data));
            v.data = {block: blocks.length - 1};
        }
    });

    return {header: epak, blocks: blocks};
}
