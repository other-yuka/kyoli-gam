import { describe, expect, it } from "vitest";

import {
  collectActionableDoctorDrift,
} from "../../../../scripts/check-kyoli-doctor-drift.mjs";

describe("collectActionableDoctorDrift", () => {
  it("leaves fingerprint and version warnings to the Class A/B automation", () => {
    const report = {
      name: "claude-binary",
      checks: [
        {
          name: "bundled template version",
          status: "warn",
          detail: "selected=2.1.206 bundled=2.1.205",
        },
      ],
    };

    expect(collectActionableDoctorDrift(report)).toEqual([]);
  });

  it("keeps runtime failures actionable", () => {
    const report = {
      name: "claude/obedience",
      checks: [
        {
          name: "client-system order",
          status: "fail",
          detail: "precedence preface was missing",
        },
      ],
    };

    expect(collectActionableDoctorDrift(report)).toEqual([
      {
        report: "claude/obedience",
        check: "client-system order",
        status: "fail",
        detail: "precedence preface was missing",
      },
    ]);
  });

  it("keeps non-fingerprint runtime warnings actionable", () => {
    const report = {
      name: "claude-binary",
      checks: [
        {
          name: "oauth config source",
          status: "warn",
          detail: "source=fallback",
        },
      ],
    };

    expect(collectActionableDoctorDrift(report)).toEqual([
      {
        report: "claude-binary",
        check: "oauth config source",
        status: "warn",
        detail: "source=fallback",
      },
    ]);
  });
});
