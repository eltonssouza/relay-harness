/**
 * Small verified slices, part of the evidence pillar.
 *
 * Problem: work that grows without a checkpoint stops being verifiable. One reported project kept
 * every commit under 500 changed lines and green in CI, 274 commits in a week; an earlier project
 * without that discipline grew one file to 4,990 lines and needed six emergency refactors. An agent
 * does not stop on its own: a request that keeps going accumulates an unreviewable diff, and a file
 * that keeps receiving code becomes the next refactor.
 *
 * Solution: two deterministic signals restated next to the latest message.
 * - Change size: lines changed in the workspace since the developer's request began. Above the
 *   guideline, the agent is told to verify and report this slice before starting more.
 * - File growth: when an edit takes a file past the line guideline (or grows an already large file
 *   substantially), the agent is told to extract before adding more.
 *
 * Measuring needs the file system and version control, which this package does not use, so the
 * runtime supplies a {@link WorkspaceProbe}. Without one, the signals are off.
 */

/** Workspace measurements supplied by the runtime. */
export interface WorkspaceProbe {
	/**
	 * Changed lines per path relative to the last commit: added plus deleted lines for tracked
	 * files, all lines for untracked ones. Undefined when unknown (for example, not a repository).
	 */
	changedLines(): Promise<ReadonlyMap<string, number> | undefined>;
	/** Line count of a file, or undefined when it does not exist or cannot be read. */
	fileLines(path: string): Promise<number | undefined>;
}

export interface SliceDisciplineOptions {
	probe: WorkspaceProbe;
	/** Changed lines per request before the agent is asked to close the slice. 0 disables. Default: 500. */
	maxChangedLines?: number;
	/** Lines per file before growth is flagged. 0 disables. Default: 1000. */
	maxFileLines?: number;
	/** Growth in one edit that flags a file already over the limit. Default: 200. */
	fileGrowthLines?: number;
}

export interface SliceStatus {
	changedLines: number;
	changedFiles: number;
	/** Files that crossed or grew past the line guideline in this request, with their line counts. */
	oversizedFiles: ReadonlyMap<string, number>;
}

/** Change-size and file-growth signals for one agent. */
export class SliceDiscipline {
	private readonly probe: WorkspaceProbe;
	private readonly maxChangedLines: number;
	private readonly maxFileLines: number;
	private readonly fileGrowthLines: number;
	/** The workspace before the request's first change. Measured lazily: requests that change nothing cost nothing. */
	private baseline: Promise<ReadonlyMap<string, number> | undefined> | undefined;
	/** Set when the probe cannot measure change size (not a repository), so it is not asked again. */
	private changeSizeUnavailable = false;
	private changedLines = 0;
	private changedFiles = 0;
	/** The latest change-size measurement, started when a tool call finished. */
	private measuring: Promise<void> | undefined;
	/** Identifies the latest measurement, so an older one finishing later cannot overwrite it. */
	private measurement = 0;
	/** File sizes before an edit, by tool call id and path. */
	private readonly before = new Map<string, number | undefined>();
	private readonly oversized = new Map<string, number>();

	constructor(options: SliceDisciplineOptions) {
		this.probe = options.probe;
		this.maxChangedLines = options.maxChangedLines ?? 500;
		this.maxFileLines = options.maxFileLines ?? 1000;
		this.fileGrowthLines = options.fileGrowthLines ?? 200;
	}

	/** A developer request starts. */
	beginRequest(): void {
		this.changedLines = 0;
		this.changedFiles = 0;
		this.baseline = undefined;
		this.measuring = undefined;
		this.measurement++;
		this.oversized.clear();
		this.before.clear();
	}

	/**
	 * Record the state before a tool call that may change the workspace: the request's baseline,
	 * on its first change, and the size of each file in `paths` it writes.
	 */
	async beforeChange(toolCallId: string, paths: readonly string[]): Promise<void> {
		if (this.maxChangedLines > 0 && !this.changeSizeUnavailable && !this.baseline) {
			this.baseline = this.probe.changedLines();
			if (!(await this.baseline)) this.changeSizeUnavailable = true;
		}
		if (this.maxFileLines <= 0) return;
		for (const path of paths) this.before.set(`${toolCallId}\0${path}`, await this.probe.fileLines(path));
	}

	/**
	 * Record a finished tool call that may have changed the workspace. `paths` are the files it
	 * wrote, when known; a shell command changes files without naming them.
	 */
	async afterChange(toolCallId: string, paths: readonly string[], isError: boolean): Promise<void> {
		// Start re-measuring now, in parallel with the rest of the turn; `refresh` awaits it.
		if (this.baseline && !this.changeSizeUnavailable) this.measuring = this.measure(++this.measurement);
		for (const path of paths) {
			const key = `${toolCallId}\0${path}`;
			const previous = this.before.get(key);
			this.before.delete(key);
			if (isError || this.maxFileLines <= 0) continue;
			const lines = await this.probe.fileLines(path);
			if (lines === undefined || lines <= this.maxFileLines) {
				this.oversized.delete(path);
				continue;
			}
			// New, crossed the guideline, or grew substantially while already over it.
			if (previous === undefined || previous <= this.maxFileLines || lines - previous >= this.fileGrowthLines) {
				this.oversized.set(path, lines);
			}
		}
	}

	/** Wait for the measurement started by the last tool call, if any. Call before a request and when a run ends. */
	async refresh(): Promise<void> {
		await this.measuring;
	}

	private async measure(id: number): Promise<void> {
		const [baseline, current] = await Promise.all([this.baseline, this.probe.changedLines()]);
		if (!baseline || !current || id !== this.measurement) return;
		let lines = 0;
		let files = 0;
		for (const path of new Set([...baseline.keys(), ...current.keys()])) {
			const delta = Math.abs((current.get(path) ?? 0) - (baseline.get(path) ?? 0));
			if (delta === 0) continue;
			lines += delta;
			files++;
		}
		this.changedLines = lines;
		this.changedFiles = files;
	}

	status(): SliceStatus {
		return { changedLines: this.changedLines, changedFiles: this.changedFiles, oversizedFiles: this.oversized };
	}

	/** Reminder lines for the harness state, or undefined when both signals are quiet. */
	render(): string | undefined {
		const lines: string[] = [];
		if (this.maxChangedLines > 0 && this.changedLines > this.maxChangedLines) {
			lines.push(
				`This request has changed about ${this.changedLines} lines in ${this.changedFiles} files (guideline: ${this.maxChangedLines}). Verify and report this slice before starting more, and propose how to split the rest.`,
			);
		}
		for (const [path, count] of this.oversized) {
			lines.push(
				`${path} now has ${count} lines (guideline: ${this.maxFileLines}). Before adding more to it, extract a cohesive part into its own module.`,
			);
		}
		return lines.length > 0 ? lines.join("\n") : undefined;
	}
}
