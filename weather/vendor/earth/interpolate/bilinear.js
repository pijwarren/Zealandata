/**
 * @param grid a grid that supports the "closest4" function.
 * @param {Float32Array} data backing data, the same length as the grid.
 * @returns {Function} a bilinear interpolation function f(λ, φ) -> v
 */
export function scalar(grid, data) {

    /**
     * @param {number} λ latitude (degrees)
     * @param {number} φ longitude (degrees)
     * @returns {number} the bilinear interpolated value or NaN if none.
     */
    function bilinear(λ, φ) {
        const indices = grid.closest4(λ, φ);

        const i00 = indices[0];
        if (i00 === i00) {
            const i10 = indices[1];
            const i01 = indices[2];
            const i11 = indices[3];
            const x = indices[4];
            const y = indices[5];
            const rx = 1 - x;
            const ry = 1 - y;

            const v00 = data[i00];
            const v10 = data[i10];
            const v01 = data[i01];
            const v11 = data[i11];

            if (v00 === v00) {
                if (v10 === v10 && v01 === v01 && v11 === v11) {
                    const a = rx * ry,  b = x * ry,  c = rx * y,  d = x * y;
                    return v00 * a + v10 * b + v01 * c + v11 * d;  // 4 points found.

                } else if (v11 === v11 && v10 === v10 && x >= y) {
                    return v10 + rx * (v00 - v10) + y * (v11 - v10);  // 3 points found, triangle interpolate.

                } else if (v01 === v01 && v11 === v11 && x < y) {
                    return v01 + x * (v11 - v01) + ry * (v00 - v01);  // 3 points found, triangle interpolate.

                } else if (v01 === v01 && v10 === v10 && x <= ry) {
                    return v00 + x * (v10 - v00) + y * (v01 - v00);  // 3 points found, triangle interpolate.
                }
            } else if (v11 === v11 && v01 === v01 && v10 === v10 && x > ry) {
                return v11 + rx * (v01 - v11) + ry * (v10 - v11);  // 3 points found, triangle interpolate.
            }
        }
        return NaN;
    }

    const hash = {};
    const {width, height} = grid.dimensions();

    /**
     * @param {GLUStick} glu
     */
    bilinear.webgl = function(glu) {
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
        // const useNative = false;  // glReport.floatTexLinear && !grid.isCylindrical();
        // if (useNative) {
        //     return {
        //         shaderSource: [scalarSource(), shaderSourceTexture2D()],
        //         textures: {weather_data: ø(texture, {TEXTURE_MIN_FILTER: gl.LINEAR, TEXTURE_MAG_FILTER: gl.LINEAR})},
        //         uniforms: {u_Data: "weather_data"},
        //     };
        // }
        return {
            shaderSource: [scalarSource(), shaderSourceBilinearWrap()],
            textures: {weather_data: texture},
            uniforms: {u_Data: "weather_data", u_TextureSize: [width, height]},
        };
    };

    return bilinear;
}

/**
 * @param grid a grid that supports the "closest4" function.
 * @param {Float32Array} data backing data in [u0, v0, u1, v1, ...] layout, double the grid size.
 * @returns {Function} a bilinear interpolation function f(λ, φ) -> [u, v]
 */
export function vector(grid, data) {

    function triangleInterpolateVector(x, y, u0, v0, u1, v1, u2, v2) {
        const u = u0 + x * (u2 - u0) + y * (u1 - u0);
        const v = v0 + x * (v2 - v0) + y * (v1 - v0);
        return [u, v];
    }

    /**
     * @param {number} λ latitude (degrees)
     * @param {number} φ longitude (degrees)
     * @returns {number[]} the bilinear interpolated value as a vector [u, v] or [NaN, NaN] if none.
     */
    function bilinear(λ, φ) {
        const indices = grid.closest4(λ, φ);

        const j00 = indices[0] * 2;
        if (j00 === j00) {
            const j10 = indices[1] * 2;
            const j01 = indices[2] * 2;
            const j11 = indices[3] * 2;
            const x = indices[4];
            const y = indices[5];
            const rx = 1 - x;
            const ry = 1 - y;

            const u00 = data[j00  ];
            const v00 = data[j00+1];
            const u10 = data[j10  ];
            const v10 = data[j10+1];
            const u01 = data[j01  ];
            const v01 = data[j01+1];
            const u11 = data[j11  ];
            const v11 = data[j11+1];

            if (v00 === v00) {
                if (v10 === v10 && v01 === v01 && v11 === v11) {
                    const a = rx * ry,  b = x * ry,  c = rx * y,  d = x * y;
                    const u = u00 * a + u10 * b + u01 * c + u11 * d;
                    const v = v00 * a + v10 * b + v01 * c + v11 * d;
                    return [u, v];  // 4 points found.

                } else if (v11 === v11 && v10 === v10 && x >= y) {
                    return triangleInterpolateVector(rx, y, u10, v10, u11, v11, u00, v00);

                } else if (v01 === v01 && v11 === v11 && x < y) {
                    return triangleInterpolateVector(x, ry, u01, v01, u00, v00, u11, v11);

                } else if (v01 === v01 && v10 === v10 && x <= ry) {
                    return triangleInterpolateVector(x, y, u00, v00, u01, v01, u10, v10);
                }
            } else if (v11 === v11 && v01 === v01 && v10 === v10 && x > ry) {
                return triangleInterpolateVector(rx, ry, u11, v11, u10, v10, u01, v01);
            }
        }
        return [NaN, NaN];
    }

    const hash = {};
    const {width, height} = grid.dimensions();

    /**
     * @param {GLUStick} glu
     */
    bilinear.webgl = function(glu) {
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
        // const useNative = false;  // glReport.floatTexLinear && !grid.isCylindrical();
        // if (useNative) {
        //     return {
        //         shaderSource: [vectorSource(), shaderSourceTexture2D()],
        //         textures: {weather_data: ø(texture, {TEXTURE_MIN_FILTER: gl.LINEAR, TEXTURE_MAG_FILTER: gl.LINEAR})},
        //         uniforms: {u_Data: "weather_data"},
        //     };
        // }
        return {
            shaderSource: [vectorSource(), shaderSourceBilinearWrap()],
            textures: {weather_data: texture},
            uniforms: {u_Data: "weather_data", u_TextureSize: [width, height]},
        };
    };

    return bilinear;
}
