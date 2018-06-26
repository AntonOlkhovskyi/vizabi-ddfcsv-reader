import { ddfCsvReader } from './ddf-csv';
import { DdfCsvError } from './ddfcsv-error';
import { IReader } from './interfaces';

export function prepareDDFCsvReaderObject(defaultFileReader?: IReader) {
  return function (externalFileReader?: IReader, logger?: any) {
    return {
      init(readerInfo) {
        this._basepath = readerInfo.path;
        this._lastModified = readerInfo._lastModified;
        this.fileReader = externalFileReader || defaultFileReader;
        this.logger = logger;
        this.resultTransformer = readerInfo.resultTransformer;
        this.reader = ddfCsvReader(this._basepath, this.fileReader, this.logger);
      },

      getAsset(asset) {
        const isJsonAsset = asset.slice(-'.json'.length) === '.json';

        return new Promise((resolve, reject) => {
          this.fileReader.readText(`${this._basepath}/${asset}`, (err, data) => {
            if (err) {
              reject(err);
              return;
            }

            if (isJsonAsset) {
              try {
                resolve(JSON.parse(data));
              } catch (jsonErr) {
                reject(err);
              }
            } else {
              resolve(data);
            }
          });
        });
      },

      async read(queryParam, parsers) {
        let result;

        try {
          result = await this.reader.query(queryParam);
          result = parsers ? this._prettifyData(result, parsers) : result;

          if (this.resultTransformer) {
            result = this.resultTransformer(result);
          }

          if (this.logger && this.logger.log) {
            logger.log(JSON.stringify(queryParam), result.length);
            logger.log(result);
          }

        } catch (error) {
          throw error;
        }

        return result;
      },

      _prettifyData(data, parsers) {
        return data.map(record => {
          const keys = Object.keys(record);

          keys.forEach(key => {
            if (parsers[ key ]) {
              record[ key ] = parsers[ key ](record[ key ]);
            }
          });

          return record;
        });
      }
    };
  };
}
