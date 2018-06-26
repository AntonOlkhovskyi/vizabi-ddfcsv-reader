import * as path from 'path';
import head = require('lodash/head');
import values = require('lodash/values');
import keys = require('lodash/keys');
import get = require('lodash/get');
import flattenDeep = require('lodash/flattenDeep');
import isEmpty = require('lodash/isEmpty');
import startsWith = require('lodash/startsWith');
import includes = require('lodash/includes');
import compact = require('lodash/compact');
import { DdfCsvError } from '../ddfcsv-error';
import { IDatapackage, IQueryOptimizationPlugin, IReader } from '../interfaces';

const Papa = require('papaparse');

const WHERE_KEYWORD = 'where';
const JOIN_KEYWORD = 'join';
const KEY_KEYWORD = 'key';
const KEY_IN = '$in';
const KEY_AND = '$and';

const getFirstConditionClause = clause => head(values(clause));
const getFirstKey = obj => head(keys(obj));
const isOneKeyBased = obj => keys(obj).length === 1;

export class InClauseUnderConjunctionPlugin implements IQueryOptimizationPlugin {
  private flow: any = {};
  private fileReader: IReader;
  private datasetPath: string;
  private query: object;
  private datapackage: IDatapackage;

  constructor (queryParam, options) {
    this.fileReader = options.fileReader;
    this.datasetPath = options.datasetPath;
    this.query = queryParam;
    this.datapackage = options.datapackage;
  }

  isMatched (): boolean {
    this.flow.joinObject = get(this.query, JOIN_KEYWORD);
    const mainAndClause = get(this.query, WHERE_KEYWORD);
    const isMainAndClauseCorrect = isOneKeyBased(mainAndClause);
    const joinKeys = keys(this.flow.joinObject);

    let areJoinKeysSameAsKeyInWhereClause = true;

    for (const key of joinKeys) {
      const joinPart = get(this.flow.joinObject, key, {});
      const firstKey = getFirstKey(joinPart[ WHERE_KEYWORD ]);

      if (joinPart[ KEY_KEYWORD ] !== firstKey && firstKey !== KEY_AND) {
        areJoinKeysSameAsKeyInWhereClause = false;
        break;
      }
    }

    return isMainAndClauseCorrect && !!this.flow.joinObject && areJoinKeysSameAsKeyInWhereClause;
  }

  async getOptimalFilesSet (): Promise<string[]> {
    if (this.isMatched()) {
      let result;
      try {
        this.fillResourceToFileHash();
        this.collectProcessableClauses();
        this.collectEntityFilesNames();
        const data = await this.collectEntities();
        this.fillEntityValuesHash(data);
        this.getFilesGroupsQueryClause();
        result = this.getOptimalFilesGroup();
      } catch (err) {
        return [];
      }
      return result;
    } else {
      throw new DdfCsvError(`Plugin "InClauseUnderConjunction" is not matched!`, 'InClauseUnderConjunction plugin');
    }
  }

  private fillResourceToFileHash (): InClauseUnderConjunctionPlugin {
    this.flow.resourceToFile = get(this.datapackage, 'resources', []).reduce((hash, resource) => {
      hash.set(resource.name, resource.path);

      return hash;
    }, new Map());

    return this;
  }

  private collectProcessableClauses (): InClauseUnderConjunctionPlugin {
    const joinKeys = keys(this.flow.joinObject);

    this.flow.processableClauses = [];

    for (const joinKey of joinKeys) {
      const where = get(this.flow.joinObject, `${joinKey}.${WHERE_KEYWORD}`, {});

      if (this.singleAndField(where)) {
        this.flow.processableClauses.push(...flattenDeep(where[ KEY_AND ].map(el => this.getProcessableClauses(el))));
      } else {
        this.flow.processableClauses.push(...this.getProcessableClauses(where));
      }
    }

    return this;
  }

  private collectEntityFilesNames (): InClauseUnderConjunctionPlugin {
    this.flow.entityFilesNames = [];
    this.flow.fileNameToPrimaryKeyHash = new Map();

    for (const schemaResourceRecord of this.datapackage.ddfSchema.entities) {
      for (const clause of this.flow.processableClauses) {
        const primaryKey = getFirstKey(clause);

        if (head(schemaResourceRecord.primaryKey) === primaryKey) {
          for (const resourceName of schemaResourceRecord.resources) {
            const file = this.flow.resourceToFile.get(resourceName);

            this.flow.entityFilesNames.push(file);
            this.flow.fileNameToPrimaryKeyHash.set(file, primaryKey);
          }
        }
      }
    }

    return this;
  }

  private collectEntities (): Promise<any> {
    const self = this;
    const actions = self.flow.entityFilesNames.map(file => new Promise((actResolve, actReject) => {
      self.fileReader.readText(path.resolve(self.datasetPath, file), (err, text) => {
        if (err) {
          return actReject(err);
        }

        Papa.parse(text, {
          header: true,
          skipEmptyLines: true,
          complete: result => actResolve({ file, result }),
          error: error => actReject(error)
        });
      });
    }));

    return Promise.all(actions);
  }

  private fillEntityValuesHash (entitiesData): InClauseUnderConjunctionPlugin {
    const getSubdomainsFromRecord = record => compact(keys(record)
      .filter(key => startsWith(key, 'is--') && (record[ key ] === 'TRUE' || record[ key ] === 'true'))
      .map(key => key.replace(/^is--/, '')));

    this.flow.entityValueToFileHash = new Map();
    this.flow.entityValueToDomainHash = new Map();

    for (const entityFileDescriptor of entitiesData) {
      for (const entityRecord of entityFileDescriptor.result.data) {
        const primaryKeyForThisFile = this.flow.fileNameToPrimaryKeyHash.get(entityFileDescriptor.file);
        const primaryKeyCellValue = entityRecord[ primaryKeyForThisFile ];
        const domainsForCurrentRecord = [ ...getSubdomainsFromRecord(entityRecord) ];

        if (isEmpty(domainsForCurrentRecord)) {
          domainsForCurrentRecord.push(primaryKeyForThisFile);
        }

        this.flow.entityValueToDomainHash.set(primaryKeyCellValue, domainsForCurrentRecord);
        this.flow.entityValueToFileHash.set(primaryKeyCellValue, entityFileDescriptor.file);
      }
    }

    return this;
  }

  private getFilesGroupsQueryClause (): InClauseUnderConjunctionPlugin {
    const filesGroupsByClause = new Map();

    for (const clause of this.flow.processableClauses) {
      const filesGroupByClause = {
        entities: new Set(),
        datapoints: new Set(),
        concepts: new Set()
      };
      const entityValuesFromClause = getFirstConditionClause(clause).$in;

      for (const entityValueFromClause of entityValuesFromClause) {
        filesGroupByClause.entities.add(this.flow.entityValueToFileHash.get(entityValueFromClause));

        const entitiesByQuery = this.flow.entityValueToDomainHash.get(entityValueFromClause);

        for (const entityByQuery of entitiesByQuery) {
          for (const schemaResourceRecord of this.datapackage.ddfSchema.datapoints) {
            for (const resourceName of schemaResourceRecord.resources) {
              if (includes(schemaResourceRecord.primaryKey, entityByQuery)) {
                filesGroupByClause.datapoints.add(this.flow.resourceToFile.get(resourceName));
              }
            }
          }
        }
      }

      for (const schemaResourceRecord of this.datapackage.ddfSchema.concepts) {
        for (const resourceName of schemaResourceRecord.resources) {
          filesGroupByClause.concepts.add(this.flow.resourceToFile.get(resourceName));
        }
      }

      filesGroupsByClause.set(clause, filesGroupByClause);
    }

    this.flow.filesGroupsByClause = filesGroupsByClause;

    return this;
  }

  private getOptimalFilesGroup (): string[] {
    const clauseKeys = this.flow.filesGroupsByClause.keys();

    let appropriateClauseKey;
    let appropriateClauseSize;

    for (const key of clauseKeys) {
      const size = this.flow.filesGroupsByClause.get(key).datapoints.size +
        this.flow.filesGroupsByClause.get(key).entities.size +
        this.flow.filesGroupsByClause.get(key).concepts.size;

      if (!appropriateClauseKey || size < appropriateClauseSize) {
        appropriateClauseKey = key;
        appropriateClauseSize = size;
      }
    }

    return [
      ...Array.from(this.flow.filesGroupsByClause.get(appropriateClauseKey).concepts),
      ...Array.from(this.flow.filesGroupsByClause.get(appropriateClauseKey).entities),
      ...Array.from(this.flow.filesGroupsByClause.get(appropriateClauseKey).datapoints)
    ] as string[];
  }

  private getProcessableClauses (clause) {
    const result = [];
    const clauseKeys = keys(clause);

    for (const key of clauseKeys) {
      if (!startsWith(key, '$') && isOneKeyBased(clause[ key ])) {
        // attention! this functionality process only first clause
        // for example, { geo: { '$in': ['world'] } }
        // in this example { geo: { '$in': ['world'] }, foo: { '$in': ['bar', 'baz'] }  }]
        // foo: { '$in': ['bar', 'baz'] } will NOT be processed
        const conditionKey = head(keys(clause[ key ]));

        if (conditionKey === KEY_IN) {
          result.push(clause);
        }
      }
    }

    return result;
  }

  private singleAndField (clause): boolean {
    return isOneKeyBased(clause) && !!get(clause, KEY_AND);
  }
}
