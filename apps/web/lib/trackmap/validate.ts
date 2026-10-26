import Ajv2020 from "ajv/dist/2020";
import schema from "@schema/trackmap.schema.json";
import type { TrackMap } from "./trackmap.generated";

const ajv = new Ajv2020({ allErrors: true });
const validateTrackMap = ajv.compile<TrackMap>(schema);

export class InvalidTrackMapError extends Error {
  override name = "InvalidTrackMapError";
}

export function parseTrackMap(data: unknown): TrackMap {
  if (validateTrackMap(data)) return data;
  throw new InvalidTrackMapError(ajv.errorsText(validateTrackMap.errors));
}
