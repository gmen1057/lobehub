import { isNil, omitBy } from 'es-toolkit/compat';

export type UnknownRecord = Record<PropertyKey, unknown>;

const isObjectLike = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null;

/** Non-null, non-array object. Used by chat input history storage. */
export const isRecord = (value: unknown): value is UnknownRecord =>
  isObjectLike(value) && !Array.isArray(value);

/**
 * Clean empty values (undefined, null, empty string) from an object
 * @param obj The object to clean
 * @returns The cleaned object
 */
export const cleanObject = <T extends Record<string, any>>(obj: T): T => {
  return omitBy(obj, (value) => isNil(value) || value === '') as T;
};
