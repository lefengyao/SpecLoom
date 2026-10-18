import type { ModelProfile, VersionToken } from "../../shared/contracts";
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
import type { ProjectCore } from "./project-core";
import { ProjectCoreWorkflowTaskAdapter } from "./workflow-task-adapter";
import { WorkflowRunner, type WorkflowRunnerOptions } from "./workflow-runner";
import { WorkflowStore } from "./workflow-store";

export interface WorkflowServiceOptions {
  /** The project the service reads and writes. Its metadata.path is the root. */
  core: ProjectCore;
  /** Resolves a run input model id to the profile its agent nodes run with. */
  resolveProfile: (modelId: string) => Promise<ModelProfile> | ModelProfile;
  /** Called after each run transition becomes durable. */
  onUpdate?: (run: WorkflowRun) => void;
}

/**
 * Project-scoped workflow facade used by the desktop IPC layer.
 *
 * It owns the definition store and the run runner for exactly one project root,
 * so callers never build either on their own. It stays Electron-free: the IPC
 * layer constructs one per current root and forwards runner updates itself.
 */
export class WorkflowService {
  private readonly root: string;
  private readonly store: WorkflowStore;
  private readonly runner: WorkflowRunner;

  constructor(options: WorkflowServiceOptions) {
    this.root = options.core.metadata.path;
    const files = new FileStore(this.root);
    this.store = new WorkflowStore(files);
    const runnerOptions: WorkflowRunnerOptions = {
      adapter: new ProjectCoreWorkflowTaskAdapter(options.core, options.resolveProfile),
      root: this.root,
      ...(options.onUpdate === undefined ? {} : { onUpdate: options.onUpdate }),
    };
    this.runner = new WorkflowRunner(runnerOptions);
  }

  list(): Promise<WorkflowSummary[]> {
    return this.store.list();
  }

  read(id: string): Promise<WorkflowSource> {
    return this.store.read(id);
  }

  save(id: string, content: string, expectedVersion: VersionToken): Promise<WorkflowSaveResult> {
    return this.store.save(id, content, expectedVersion);
  }

  remove(id: string, expectedVersion: VersionToken): Promise<void> {
    return this.store.remove(id, expectedVersion);
  }

  copyOfficial(id: string): Promise<WorkflowCopyResult> {
    return this.store.copyOfficial(id);
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
}
