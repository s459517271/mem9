import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "@/i18n";
import { DeepAnalysisTab } from "./deep-analysis-tab";

const mocks = vi.hoisted(() => ({
  useDeepAnalysisReports: vi.fn(),
  invalidateQueries: vi.fn(async () => undefined),
  downloadDeepAnalysisDuplicatesCsv: vi.fn(async () => new Blob(["duplicateMemoryId\nmem_2\n"], { type: "text/csv" })),
  deleteDeepAnalysisDuplicates: vi.fn(async () => ({
    reportId: "dar_completed",
    duplicateCleanup: {
      status: "QUEUED",
      requestedAt: "2026-03-29T00:00:00Z",
      startedAt: null,
      completedAt: null,
      totalCount: 2,
      deletedCount: 0,
      failedCount: 0,
      deletedMemoryIds: [],
      failedMemoryIds: [],
      errorMessage: null,
    },
  })),
  deleteDeepAnalysisReport: vi.fn(async () => ({
    reportId: "dar_completed",
  })),
}));

vi.mock("@/api/deep-analysis-queries", () => ({
  useDeepAnalysisReports: mocks.useDeepAnalysisReports,
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    invalidateQueries: mocks.invalidateQueries,
  }),
}));

vi.mock("@/api/analysis-client", () => ({
  analysisApi: {
    downloadDeepAnalysisDuplicatesCsv: mocks.downloadDeepAnalysisDuplicatesCsv,
    deleteDeepAnalysisDuplicates: mocks.deleteDeepAnalysisDuplicates,
    deleteDeepAnalysisReport: mocks.deleteDeepAnalysisReport,
  },
  AnalysisApiError: class AnalysisApiError extends Error {},
}));

describe("DeepAnalysisTab", () => {
  it("renders the empty state and triggers deep analysis creation", () => {
    const createReport = vi.fn(async () => undefined);
    mocks.useDeepAnalysisReports.mockReturnValue({
      reports: [],
      selectedReport: null,
      selectedReportId: null,
      setSelectedReportId: vi.fn(),
      inlineError: null,
      clearInlineError: vi.fn(),
      isLoading: false,
      isCreating: false,
      createReport,
    });

    render(<DeepAnalysisTab spaceId="space-1" active />);

    expect(screen.getByText("No analysis reports yet")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Deep Analysis" })[0]!);
    expect(createReport).toHaveBeenCalledWith({
      lang: expect.any(String),
      timezone: expect.any(String),
    });
  });

  it("renders compact history cards and the selected in-progress report", () => {
    mocks.useDeepAnalysisReports.mockReturnValue({
      reports: [
        {
          id: "dar_latest",
          status: "ANALYZING",
          stage: "CHUNK_ANALYSIS",
          progressPercent: 42,
          lang: "en",
          timezone: "Asia/Shanghai",
          memoryCount: 1200,
          requestedAt: "2026-03-28T09:00:00Z",
          startedAt: "2026-03-28T09:01:00Z",
          completedAt: null,
          errorCode: null,
          errorMessage: null,
          preview: {
            generatedAt: "2026-03-28T09:00:00Z",
            summary: "Current report is synthesizing product and persona signals.",
            topThemes: ["product"],
            keyRecommendations: ["Deduplicate repeated notes"],
          },
        },
        {
          id: "dar_old",
          status: "COMPLETED",
          stage: "COMPLETE",
          progressPercent: 100,
          lang: "en",
          timezone: "Asia/Shanghai",
          memoryCount: 1100,
          requestedAt: "2026-03-27T09:00:00Z",
          startedAt: "2026-03-27T09:01:00Z",
          completedAt: "2026-03-27T09:05:00Z",
          errorCode: null,
          errorMessage: null,
          preview: {
            generatedAt: "2026-03-27T09:05:00Z",
            summary: "Previous report summary.",
            topThemes: ["engineering"],
            keyRecommendations: ["Capture more people signals"],
          },
        },
      ],
      selectedReport: {
        id: "dar_latest",
        status: "ANALYZING",
        stage: "CHUNK_ANALYSIS",
        progressPercent: 42,
        lang: "en",
        timezone: "Asia/Shanghai",
        memoryCount: 1200,
        requestedAt: "2026-03-28T09:00:00Z",
        startedAt: "2026-03-28T09:01:00Z",
        completedAt: null,
        errorCode: null,
        errorMessage: null,
        preview: {
          generatedAt: "2026-03-28T09:00:00Z",
          summary: "Current report is synthesizing product and persona signals.",
          topThemes: ["product"],
          keyRecommendations: ["Deduplicate repeated notes"],
        },
        report: null,
      },
      selectedReportId: "dar_latest",
      setSelectedReportId: vi.fn(),
      inlineError: null,
      clearInlineError: vi.fn(),
      isLoading: false,
      isCreating: false,
      createReport: vi.fn(async () => undefined),
    });

    render(<DeepAnalysisTab spaceId="space-1" active />);

    expect(screen.queryByText("Current report is synthesizing product and persona signals.")).not.toBeInTheDocument();
    expect(screen.queryByText("Previous report summary.")).not.toBeInTheDocument();
    expect(screen.getByText("Loading report history…")).toBeInTheDocument();
    expect(screen.queryByText("Completed")).not.toBeInTheDocument();
  });

  it("renders the richer persona fields, downloads cleanup csv, and deletes duplicate memories", async () => {
    const createObjectUrl = vi.fn(() => "blob:report");
    const revokeObjectUrl = vi.fn();
    const click = vi.fn();
    const originalCreateElement = document.createElement.bind(document);
    vi.stubGlobal("URL", {
      createObjectURL: createObjectUrl,
      revokeObjectURL: revokeObjectUrl,
    });
    vi.spyOn(document, "createElement").mockImplementation(((tagName: string) => {
      if (tagName === "a") {
        return {
          click,
          href: "",
          download: "",
        } as unknown as HTMLAnchorElement;
      }
      return originalCreateElement(tagName);
    }) as typeof document.createElement);

    mocks.useDeepAnalysisReports.mockReturnValue({
      reports: [
        {
          id: "dar_completed",
          status: "COMPLETED",
          stage: "COMPLETE",
          progressPercent: 100,
          lang: "zh-CN",
          timezone: "Asia/Shanghai",
          memoryCount: 1400,
          requestedAt: "2026-03-28T00:00:00Z",
          startedAt: "2026-03-28T00:01:00Z",
          completedAt: "2026-03-28T00:05:00Z",
          errorCode: null,
          errorMessage: null,
          preview: {
            generatedAt: "2026-03-28T00:05:00Z",
            summary: "A deeper operational persona summary.",
            topThemes: ["dashboard roadmap"],
            keyRecommendations: ["Deduplicate repeated notes"],
          },
        },
      ],
      selectedReport: {
        id: "dar_completed",
        status: "COMPLETED",
        stage: "COMPLETE",
        progressPercent: 100,
        lang: "zh-CN",
        timezone: "Asia/Shanghai",
        memoryCount: 1400,
        requestedAt: "2026-03-28T00:00:00Z",
        startedAt: "2026-03-28T00:01:00Z",
        completedAt: "2026-03-28T00:05:00Z",
        errorCode: null,
        errorMessage: null,
        preview: {
          generatedAt: "2026-03-28T00:05:00Z",
          summary: "A deeper operational persona summary.",
          topThemes: ["dashboard roadmap"],
          keyRecommendations: ["Deduplicate repeated notes"],
        },
        report: {
          overview: {
            memoryCount: 1400,
            deduplicatedMemoryCount: 1200,
            generatedAt: "2026-03-28T00:05:00Z",
            lang: "zh-CN",
            timeSpan: {
              start: "2026-03-01T00:00:00Z",
              end: "2026-03-28T00:00:00Z",
            },
          },
          persona: {
            summary: "The corpus highlights repeated operational decisions and structured engineering habits.",
            workingStyle: ["Prefers structured reviews and staged rollouts."],
            goals: ["Wants durable memory insight workflows."],
            preferences: ["Prefers concise but information-dense summaries."],
            constraints: ["Avoids deleting canonical memories during cleanup."],
            decisionSignals: ["Tradeoffs frequently balance speed and correctness."],
            notableRoutines: ["Reviews traffic dashboards every morning."],
            contradictionsOrTensions: ["The user wants concise output without losing important implementation detail."],
            evidenceHighlights: [
              {
                title: "Evidence 1",
                detail: "Reviews traffic dashboards every morning.",
                memoryIds: ["mem_3"],
              },
            ],
          },
          themeLandscape: {
            highlights: [
              {
                name: "dashboard roadmap",
                count: 12,
                description: "Recurring phrase found in 12 memories.",
              },
            ],
          },
          entities: {
            people: [{ label: "Alice Johnson", count: 7, evidenceMemoryIds: ["mem_1"] }],
            teams: [{ label: "Platform Team", count: 4, evidenceMemoryIds: ["mem_2"] }],
            projects: [],
            tools: [],
            places: [],
          },
          relationships: [],
          discoveries: [
            {
              id: "focus:dashboard-roadmap",
              kind: "focus_area",
              title: "Focus area: dashboard roadmap",
              summary: "Project memories around the dashboard roadmap form one of the strongest recurring workstreams.",
              confidence: 0.82,
              evidenceMemoryIds: ["mem_1"],
            },
          ],
          quality: {
            duplicateRatio: 0.12,
            duplicateMemoryCount: 18,
            noisyMemoryCount: 4,
            duplicateClusters: [
              {
                canonicalMemoryId: "mem_1",
                duplicateMemoryIds: ["mem_2", "mem_3"],
              },
            ],
            lowQualityExamples: [],
            coverageGaps: [],
          },
          recommendations: ["Collapse duplicate drift regularly."],
          productSignals: {
            candidateNodes: [],
            candidateEdges: [],
            searchSeeds: [],
          },
        },
      },
      selectedReportId: "dar_completed",
      setSelectedReportId: vi.fn(),
      inlineError: null,
      clearInlineError: vi.fn(),
      isLoading: false,
      isCreating: false,
      createReport: vi.fn(async () => undefined),
    });

    render(<DeepAnalysisTab spaceId="space-1" active />);

    expect(screen.getByText("Working Style")).toBeInTheDocument();
    expect(screen.getByText("Key Discoveries")).toBeInTheDocument();
    expect(screen.getByText("Focus area: dashboard roadmap")).toBeInTheDocument();
    expect(screen.getByText("Decision Signals")).toBeInTheDocument();
    expect(screen.getByText("Representative Evidence")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));

    await waitFor(() => {
      expect(mocks.downloadDeepAnalysisDuplicatesCsv).toHaveBeenCalledWith("space-1", "dar_completed");
      expect(createObjectUrl).toHaveBeenCalledTimes(1);
      expect(click).toHaveBeenCalledTimes(1);
      expect(revokeObjectUrl).toHaveBeenCalledWith("blob:report");
    });

    fireEvent.click(screen.getByRole("button", { name: "Delete dupes" }));
    expect(screen.getByText("Delete the duplicate memories found in this report? This starts a background cleanup and the deleted memories cannot be restored.")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(mocks.deleteDeepAnalysisDuplicates).toHaveBeenCalledWith("space-1", "dar_completed");
      expect(screen.getByText("Started deleting 2 duplicate memories in the background.")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Delete report" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(mocks.deleteDeepAnalysisReport).toHaveBeenCalledWith("space-1", "dar_completed");
    });
  });

  it("renders legacy deep-analysis payloads without crashing when timeSpan and wrapped highlights are missing", () => {
    mocks.useDeepAnalysisReports.mockReturnValue({
      reports: [
        {
          id: "dar_legacy",
          status: "COMPLETED",
          stage: "COMPLETE",
          progressPercent: 100,
          lang: "en",
          timezone: "Asia/Shanghai",
          memoryCount: 4040,
          requestedAt: "2026-03-28T10:13:05.010Z",
          startedAt: "2026-03-28T10:13:53.760Z",
          completedAt: "2026-03-28T10:15:28.107Z",
          errorCode: null,
          errorMessage: null,
          preview: {
            generatedAt: "2026-03-28T10:15:28.107Z",
            summary: "Bosn operates as a high-velocity ENFP product leader and engineering lead at PingCAP.",
            topThemes: [],
            keyRecommendations: [
              "Collapse repeated memories into stronger canonical entries and clean up duplicate drift regularly.",
            ],
          },
        },
      ],
      selectedReport: {
        id: "dar_legacy",
        status: "COMPLETED",
        stage: "COMPLETE",
        progressPercent: 100,
        lang: "en",
        timezone: "Asia/Shanghai",
        memoryCount: 4040,
        requestedAt: "2026-03-28T10:13:05.010Z",
        startedAt: "2026-03-28T10:13:53.760Z",
        completedAt: "2026-03-28T10:15:28.107Z",
        errorCode: null,
        errorMessage: null,
        preview: {
          generatedAt: "2026-03-28T10:15:28.107Z",
          summary: "Bosn operates as a high-velocity ENFP product leader and engineering lead at PingCAP.",
          topThemes: [],
          keyRecommendations: [
            "Collapse repeated memories into stronger canonical entries and clean up duplicate drift regularly.",
          ],
        },
        report: {
          overview: {
            memoryCount: 4040,
            deduplicatedMemoryCount: 3635,
            analysisScope: "Deep synthesis of operational logs and persona signals across 4k+ memories.",
          },
          persona: {
            summary: "Bosn operates as a high-velocity ENFP product leader and engineering lead at PingCAP.",
            workingStyle: ["Enforces explicit approval for system updates and gateway restarts"],
            preferences: ["Official stable releases only; ignore beta versions for checks"],
          },
          themeLandscape: [
            {
              name: "healthcheck skill execution",
              count: 320,
              description: "Dominant operational theme involving model self-checks and security audits.",
            },
          ],
          entities: {
            people: [
              {
                label: "Bosn",
                role: "Product Design Lead / Engineering Lead",
                count: 196,
                evidenceMemoryIds: ["mem_1"],
              },
            ],
            teams: [
              {
                label: "PingCAP Engineering",
                context: "TiDB Cloud infrastructure and Databend development",
                evidenceMemoryIds: ["mem_2"],
              },
            ],
            projects: [],
            tools: [],
            places: [],
          },
          relationships: [],
          discoveries: [],
          quality: {
            lowQualityExamples: [
              { memoryId: "mem_3", reason: "Very short or low-information memory" },
              { memoryId: "mem_4", reason: "Very short or low-information memory" },
            ],
            coverageGaps: [
              "Limited detail on specific TiDB Cloud cluster configurations beyond spend limits",
            ],
            duplicateMemoryCount: 30,
          },
          recommendations: [
            "Collapse repeated memories into stronger canonical entries and clean up duplicate drift regularly.",
          ],
          productSignals: {
            candidateNodes: [],
            candidateEdges: [],
            searchSeeds: [],
          },
        },
      },
      selectedReportId: "dar_legacy",
      setSelectedReportId: vi.fn(),
      inlineError: null,
      clearInlineError: vi.fn(),
      isLoading: false,
      isCreating: false,
      createReport: vi.fn(async () => undefined),
    });

    render(<DeepAnalysisTab spaceId="space-1" active />);

    expect(screen.getByText("healthcheck skill execution")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "PingCAP Engineering" })).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });
});
