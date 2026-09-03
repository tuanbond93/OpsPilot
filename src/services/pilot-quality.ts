export type PilotVerification = {
  incidentId: string;
  actualCause: string;
  verifiedAt: string;
  warehouseName: string;
  incidentType: string;
};

export type PilotFeedback = {
  id: string;
  category: string;
  reportedAt: string;
  currentStatus: "OPEN" | "IN_PROGRESS" | "RESOLVED";
};

export type PilotReview = {
  status: string;
  rating: number | null;
  reviewedAt: string;
};

export type PilotDecision = {
  id: string;
  mode: string;
  status: string;
};

export type PilotOutcome = {
  decisionId: string;
  status: string;
  measuredAt: string;
};

/** An LC-06 verifier record, distinct from an operator-observed outcome. */
export type PilotVerifiedOutcome = {
  decisionId: string;
  classification: string;
  verifiedAt: string;
};

export type PilotQualitySnapshot = ReturnType<typeof buildPilotQualitySnapshot>;

function countBy<T>(items: T[], key: (item: T) => string) {
  return Object.entries(
    items.reduce<Record<string, number>>((counts, item) => {
      const value = key(item);
      counts[value] = (counts[value] || 0) + 1;
      return counts;
    }, {}),
  )
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function day(value: string) {
  return value.slice(0, 10);
}

export function buildPilotQualitySnapshot(input: {
  verifications: PilotVerification[];
  feedback: PilotFeedback[];
  reviews: PilotReview[];
  decisions: PilotDecision[];
  outcomes: PilotOutcome[];
  verifiedOutcomes?: PilotVerifiedOutcome[];
  authEnforced?: boolean;
  generatedAt?: string;
}) {
  const reviewed = input.reviews.filter((review) =>
    ["APPROVED", "EDITED", "REJECTED"].includes(review.status),
  );
  const rated = reviewed.filter((review) => review.rating !== null);
  const decisionsWithOutcome = new Set(input.outcomes.map((outcome) => outcome.decisionId));
  const decisionsWithVerifiedOutcome = new Set((input.verifiedOutcomes || []).map((outcome) => outcome.decisionId));
  const resolvedFeedback = input.feedback.filter((item) => item.currentStatus === "RESOLVED").length;
  const verifiedWarehouses = new Set(input.verifications.map((item) => item.warehouseName));
  const activity = [
    ...input.verifications.map((item) => ({ date: day(item.verifiedAt), type: "VERIFICATION" })),
    ...input.feedback.map((item) => ({ date: day(item.reportedAt), type: "FEEDBACK" })),
    ...reviewed.map((item) => ({ date: day(item.reviewedAt), type: "REVIEW" })),
    ...input.outcomes.map((item) => ({ date: day(item.measuredAt), type: "OUTCOME" })),
  ];
  const activityDates = [...new Set(activity.map((item) => item.date))].sort().slice(-14);

  return {
    generatedAt: input.generatedAt || new Date().toISOString(),
    sample: {
      verifiedIncidents: new Set(input.verifications.map((item) => item.incidentId)).size,
      verificationRecords: input.verifications.length,
      reviewedCopilotResults: reviewed.length,
      decisionsObserved: decisionsWithOutcome.size,
      verifiedWarehouses: verifiedWarehouses.size,
    },
    review: {
      approved: reviewed.filter((item) => item.status === "APPROVED").length,
      edited: reviewed.filter((item) => item.status === "EDITED").length,
      rejected: reviewed.filter((item) => item.status === "REJECTED").length,
      averageRating:
        rated.length > 0
          ? Number((rated.reduce((sum, item) => sum + (item.rating || 0), 0) / rated.length).toFixed(1))
          : null,
    },
    verificationCauses: countBy(input.verifications, (item) => item.actualCause),
    verificationCoverage: {
      byWarehouse: countBy(input.verifications, (item) => item.warehouseName),
      byIncidentType: countBy(input.verifications, (item) => item.incidentType),
    },
    feedback: {
      total: input.feedback.length,
      open: input.feedback.filter((item) => item.currentStatus === "OPEN").length,
      inProgress: input.feedback.filter((item) => item.currentStatus === "IN_PROGRESS").length,
      resolved: resolvedFeedback,
      resolutionRate:
        input.feedback.length > 0
          ? Number((resolvedFeedback / input.feedback.length).toFixed(4))
          : null,
      byCategory: countBy(input.feedback, (item) => item.category),
    },
    decision: {
      total: input.decisions.length,
      shadow: input.decisions.filter((item) => item.mode === "SHADOW").length,
      humanApproval: input.decisions.filter((item) => item.mode === "HUMAN_APPROVAL").length,
      withOutcome: decisionsWithOutcome.size,
      withVerifiedOutcome: decisionsWithVerifiedOutcome.size,
      outcomeCoverage:
        input.decisions.length > 0
          ? Number((decisionsWithOutcome.size / input.decisions.length).toFixed(4))
          : null,
      outcomes: countBy(input.outcomes, (item) => item.status),
      verifiedOutcomes: countBy(input.verifiedOutcomes || [], (item) => item.classification),
      verifiedOutcomeCoverage:
        input.decisions.length > 0
          ? Number((decisionsWithVerifiedOutcome.size / input.decisions.length).toFixed(4))
          : null,
    },
    activityTrend: activityDates.map((date) => ({
      date,
      verifications: activity.filter((item) => item.date === date && item.type === "VERIFICATION").length,
      reviews: activity.filter((item) => item.date === date && item.type === "REVIEW").length,
      feedback: activity.filter((item) => item.date === date && item.type === "FEEDBACK").length,
      outcomes: activity.filter((item) => item.date === date && item.type === "OUTCOME").length,
    })),
    readiness: [
      {
        key: "human_verification",
        label: "Nguyên nhân được con người xác minh",
        state: input.verifications.length > 0 ? "HAS_EVIDENCE" : "NO_EVIDENCE",
        evidence: `${input.verifications.length} bản ghi tại ${verifiedWarehouses.size} kho`,
      },
      {
        key: "copilot_review",
        label: "Copilot có human review",
        state: reviewed.length > 0 ? "HAS_EVIDENCE" : "NO_EVIDENCE",
        evidence: `${reviewed.length} kết quả đã có quyết định review`,
      },
      {
        key: "feedback_loop",
        label: "Phản hồi Pilot có quy trình xử lý",
        state: input.feedback.length > 0 ? "HAS_EVIDENCE" : "NO_EVIDENCE",
        evidence: `${resolvedFeedback}/${input.feedback.length} phản hồi đã đóng`,
      },
      {
        key: "decision_outcome",
        label: "Decision có outcome đã được xác thực",
        state: decisionsWithVerifiedOutcome.size > 0 ? "HAS_EVIDENCE" : "NO_EVIDENCE",
        evidence: `${decisionsWithVerifiedOutcome.size}/${input.decisions.length} Decision có outcome qua LC-06 verifier; outcome tự ghi không được tính là verified`,
      },
      {
        key: "identity_rbac",
        label: "Danh tính và phân quyền production",
        state: input.authEnforced ? "HAS_EVIDENCE" : "LIMITATION",
        evidence: input.authEnforced ? "API actor lấy từ Supabase session và được kiểm tra role" : "Actor đang được ghi nhận nhưng chưa bật AUTH_ENFORCEMENT_ENABLED",
      },
      {
        key: "autonomous_safety",
        label: "An toàn thực thi tự động",
        state: "SAFETY_LOCKED",
        evidence: "AUTONOMOUS bị chặn; SHADOW không tác động vận hành",
      },
    ] as const,
  };
}
