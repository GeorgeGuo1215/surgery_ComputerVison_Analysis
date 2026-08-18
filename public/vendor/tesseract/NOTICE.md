# Vendored Tesseract OCR resources

These files are served from the application's own origin so OCR does not depend on a third-party CDN at runtime.

| File | Upstream | Version | SHA-256 |
| --- | --- | --- | --- |
| `worker.min.js` | `tesseract.js` | 6.0.1 | `38645599043239c0eb6db08a6504a92dcdc292200535f3e9339cd77c4443b842` |
| `core/tesseract-core-lstm.wasm.js` | `tesseract.js-core` | 6.1.2 | `775a35df6f2ae100e02609443e6bd5cafcd07983dd6175454ca4a432a7730687` |
| `core/tesseract-core-simd-lstm.wasm.js` | `tesseract.js-core` | 6.1.2 | `9d7c43fb206dc9f48475228b46bf35f888fa9e6259da2e67d5a75c77049f2dc7` |
| `lang/eng.traineddata.gz` | `@tesseract.js-data/eng`, `4.0.0_best_int` | 1.0.0 | `45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91` |

The language model was compared byte-for-byte with the file in the npm registry tarball whose SHA-1 is `285a3f1fb419e8e67bdee93ce288b02bb9097f0a`.

The Tesseract.js, Tesseract.js Core, and tessdata repositories are licensed under Apache-2.0. Corresponding license texts are retained in `licenses/`.
