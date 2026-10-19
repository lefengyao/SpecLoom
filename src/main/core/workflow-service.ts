import type { ModelProfile, VersionToken } from "../../shared/contracts";
import type { OrchestrationRun, WorkflowSettings } from "../../shared/orchestration";
import type {
  OrchestrationSaveResult,
  OrchestrationSource,
  OrchestrationSummary,
} from "../../shared/orchestration-api";
import type { WorkflowDefinition } from "../../shared/workflow";
import type {
  WorkflowCopyResult,
  WorkflowRetryAction,
  WorkflowRun,
  WorkflowRunInputs,
  WorkflowSaveResult,
  WorkflowSource,
  WorkflowSummary,
} from "../../shared/workflow-api";
import { FileStore } from "./file-store";
import { OrchestrationRunStore } from "./orchestration-run-store";
import { OrchestrationStore } from "./orchestration-store";
import type { ProjectCore } from "./project-core";
import { loadOfficialWorkflow } from "./workflow-official";
import { WorkflowOrchestrator } from "./workflow-orchestrator";
import { ProjectCoreWorkflowTaskAdapter } from "./workflow-task-adapter";
import { WorkflowRunner, type WorkflowRunnerOptions } from "./workflow-runner";
import { WorkflowSettingsStore } from "./workflow-settings-store";
import type { OfficialWorkflowLoader } from "./workflow-store";
import { WorkflowStore } from "./workflow-store";

export interface WorkflowServiceOptions {
  /** The project the service reads and writes. Its metadata.path is the root. */
  core: ProjectCore;
  /** Resolves a run input model id to the profile its agent nodes run with. */
  resolveProfile: (modelId: string) => Promise<ModelProfile> | ModelProfile;
  /** Called after each workflow run transition becomes durable. */
  onUpdate?: (run: WorkflowRun) => void;
  /** Called after each orchestration transition becomes durable. */
  onOrchestrationUpdate?: (run: OrchestrationRun) => void;
  /** Loads the bundled official workflow; injectable for tests. */
  loadOfficial?: OfficialWorkflowLoader;
}

/**
 * Project-scoped workflow facade used by the desktop IPC layer.
 *
 * It owns the definition stores, the settings store, the run runner, and the
 * sequential orchestrator for exactly one project root, so callers never build
 * any of them on their own. It stays Electron-free: the IPC layer constructs
 * one per current root and forwards the durable updates itself.
 */
export class WorkflowService {
  private readonly root: string;
  private readonly workflows: WorkflowStore;
  private readonly settings: WorkflowSettingsStore;
  private readonly orchestrations: OrchestrationStore;
  private readonly runner: WorkflowRunner;
  private readonly orchestrator: WorkflowOrchestrator;

  constructor(options: WorkflowServiceOptions) {
    this.root = options.core.metadata.path;
    const files = new FileStore(this.root);
    const loadOfficial = options.loadOfficial ?? loadOfficialWorkflow;
    this.workflows = new WorkflowStore(files, loadOfficial);
    this.settings = new WorkflowSettingsStore(this.root);
    this.orchestrations = new OrchestrationStore(files);

    const runnerOptions: WorkflowRunnerOptions = {
      adapter: new ProjectCoreWorkflowTaskAdapter(options.core, options.resolveProfile),
      root: this.root,
      ...(options.onUpdate === undefined ? {} : { onUpdate: options.onUpdate }),
    };
    this.runner = new WorkflowRunner(runnerOptions);

    this.orchestrator = new WorkflowOrchestrator({
      runStore: new OrchestrationRunStore(this.root),
      orchestrationStore: this.orchestrations,
      loadWorkflow: async (id) => (await this.workflows.read(id)).definition,
      loadOfficial,
      runner: this.runner,
      ...(options.onOrchestrationUpdate === undefined ? {} : { onUpdate: options.onOrchestrationUpdate }),
    });
  }

  list(): Promise<WorkflowSummary[]> {
    return this.workflows.list();
  }

  read(id: string): Promise<WorkflowSource> {
    return this.workflows.read(id);
  }

  save(id: string, content: string, expectedVersion: VersionToken): Promise<WorkflowSaveResult> {
    return this.workflows.save(id, content, expectedVersion);
  }

  remove(id: string, expectedVersion: VersionToken): Promise<void> {
    return this.workflows.remove(id, expectedVersion);
  }

  copyOfficial(id: string): Promise<WorkflowCopyResult> {
    return this.workflows.copyOfficial(id);
  }

  /**
   * Validate and snapshot a run, start it in the background, then return the
   * durable record. Node execution continues past this call; observe it through
   * getRun/listRuns or the onUpdate callback.
   */
  async start(definition: WorkflowDefinition, inputs: WorkflowRunInputs): Promise<WorkflowRun> {
    const run = this.runner.createRun(definition, inputs);
    await this.runner.start(run.runId);
    return await this.runner.getRun(run.runId);
  }

  getRun(runId: string): Promise<WorkflowRun> {
    return this.runner.getRun(runId);
  }

  listRuns(): Promise<WorkflowRun[]> {
    return this.runner.listRuns();
  }

  approve(runId: string, digest: string): Promise<void> {
    return this.runner.approve(runId, digest);
  }

  reject(runId: string): Promise<void> {
    return this.runner.reject(runId);
  }

  retry(runId: string, action: WorkflowRetryAction): Promise<void> {
    return this.runner.retry(runId, action);
  }

  cancel(runId: string): Promise<void> {
    return this.runner.cancel(runId);
  }

  // --- Project workflow defaults -------------------------------------------

  /** The project-level workflow settings; a missing or invalid file reads empty. */
  defaultsRead(): Promise<WorkflowSettings> {
    return this.settings.read();
  }

  /** Validate and atomically replace the project workflow defaults. */
  defaultsSave(settings: WorkflowSettings): Promise<WorkflowSettings> {
    return this.settings.save(settings);
  }

  /** Remove the project override, restoring the global (official) default. */
  defaultsClear(): Promise<WorkflowSettings> {
    return this.settings.clearDefault();
  }

  // --- Orchestration definitions -------------------------------------------

  orchestrationList(): Promise<OrchestrationSummary[]> {
    return this.orchestrations.list();
  }

  orchestrationRead(id: string): Promise<OrchestrationSource> {
    return this.orchestrations.read(id);
  }

  orchestrationSave(
    id: string,
    content: string,
    expectedVersion: VersionToken,
  ): Promise<OrchestrationSaveResult> {
    return this.orchestrations.save(id, content, expectedVersion);
  }

  orchestrationRemove(id: string, expectedVersion: VersionToken): Promise<void> {
    return this.orchestrations.remove(id, expectedVersion);
  }

  // --- Orchestration runs --------------------------------------------------

  /**
   * Validate a definition and its step workflows, persist a queued run, then
   * advance it in the background. Observe it through orchestrationGetRun,
   * orchestrationListRuns, or the onOrchestrationUpdate callback.
   */
  orchestrationStart(orchestrationId: string, inputs: WorkflowRunInputs): Promise<OrchestrationRun> {
    return this.orchestrator.start(orchestrationId, inputs);
  }

  orchestrationGetRun(orchestrationRunId: string): Promise<OrchestrationRun> {
    return this.orchestrator.getRun(orchestrationRunId);
  }

  orchestrationListRuns(): Promise<OrchestrationRun[]> {
    return this.orchestrator.listRuns();
  }

  orchestrationApproveStep(orchestrationRunId: string, digest: string): Promise<void> {
    return this.orchestrator.approveStep(orchestrationRunId, digest);
  }

  orchestrationRejectStep(orchestrationRunId: string): Promise<void> {
    return this.orchestrator.rejectStep(orchestrationRunId);
  }

  orchestrationRetryStep(
    orchestrationRunId: string,
    action: WorkflowRetryAction,
  ): Promise<void> {
    return this.orchestrator.retryStep(orchestrationRunId, action);
  }

  orchestrationCancel(orchestrationRunId: string): Promise<void> {
    return this.orchestrator.cancel(orchestrationRunId);
  }

  /** Poll one orchestration run until a caller-chosen state is reached. */
  waitForOrchestrationRun(
    orchestrationRunId: string,
    predicate: (run: OrchestrationRun) => boolean,
    timeoutMs?: number,
  ): Promise<OrchestrationRun> {
    return this.orchestrator.waitForRun(orchestrationRunId, predicate, timeoutMs);
  }
}
