import { createClaimsManager, type ClaimsMap } from "opencode-multi-account-core";
import { CLAIMS_FILENAME } from "./constants";

const claimsManager = createClaimsManager(CLAIMS_FILENAME);

export const {
  isClaimedByOther,
  readClaims,
  releaseClaim,
  writeClaim,
} = claimsManager;

export type { ClaimsMap };
