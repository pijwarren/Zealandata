/**
 * @param grid a grid that supports the "closest" function.
 * @param {Float32Array} data backing data, the same length as the grid.
 * @returns {Function} a nearest neighbor interpolation function f(λ, φ) -> v
 */
export function scalar(grid, data) {

    /**
     * @param {number} λ latitude (degrees)
     * @param {number} φ longitude (degrees)
     * @returns {number} the nearest neighbor value or NaN if none.
     */
    function nearest(λ, φ) {
        return +data[grid.closest(λ, φ)];
    }

    const hash = {};
    const {width, height} = grid.dimensions();

    /**
     * @param {GLUStick} glu
     */
    nearest.webgl = function(glu) {
        const gl = glu.context;
        const texture = {
            type: gl.FLOAT,
            format: gl.LUMINANCE,
            width,
            height,
            pixels: data,
            hash: hash,
            TEXTURE_MIN_FILTER: gl.NEAREST,
            TEXTURE_MAG_FILTER: gl.NEAREST,
        };
        return {
            shaderSource: [scalarSource(), shaderSourceTexture2D()],
            textures: {weather_data: texture},
            uniforms: {u_Data: "weather_data"},
        };
    };

    return nearest;
}

/**
 * @param grid a grid that supports the "closest" function.
 * @param {Float32Array} data backing data in [u0, v0, u1, v1, ...] layout, double the grid size.
 * @returns {Function} a nearest neighbor interpolation function f(λ, φ) -> [u, v]
 */
export function vector(grid, data) {

    /**
     * @param {number} λ latitude (degrees)
     * @param {number} φ longitude (degrees)
     * @returns {number[]} the nearest neighbor value as a vector [u, v] or [NaN, NaN] if none.
     */
    function nearest(λ, φ) {
        const j = grid.closest(λ, φ) * 2;  // j is an index into an interleaved vec2 array
        if (j === j) {
            const u = data[j];
            const v = data[j+1];
            if (u === u && v === v) {
                return [u, v];
            }
        }
        return [NaN, NaN];
    }

    const hash = {};
    const {width, height} = grid.dimensions();

    /**
     * @param {GLUStick} glu
     */
    nearest.webgl = function(glu) {
        const gl = glu.context;
        const texture = {
            type: gl.FLOAT,
            format: gl.LUMINANCE_ALPHA,
            width,
            height,
            pixels: data,
            hash: hash,
            TEXTURE_MIN_FILTER: gl.NEAREST,
            TEXTURE_MAG_FILTER: gl.NEAREST,
        };
        return {
            shaderSource: [vectorSource(), shaderSourceTexture2D()],
            textures: {weather_data: texture},
            uniforms: {u_Data: "weather_data"},
        };
    };

    return nearest;
}
