import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateLibraryDataset } from "../packages/coding-agent/src/extensions/laya/library-data.ts";
import { readLibraryIndex } from "../packages/coding-agent/src/extensions/laya/library.ts";
import { layaDecisionsFile } from "../packages/coding-agent/src/extensions/laya/questions.ts";
import { TRAIN_SCRIPT } from "../packages/coding-agent/src/extensions/laya/train-script.ts";
import { passesGate, trainingWorkspace, writeRegistry } from "../packages/coding-agent/src/extensions/laya/training.ts";
import { LAYA_IMAGE_PATHS, LAYA_MODELS_VOLUME } from "../packages/coding-agent/src/extensions/laya/runtime.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = resolve(repo, ".laya");
const [command, argument, initialModel, recipe = "standard"] = process.argv.slice(2);
const image = process.env.LAYA_TRAIN_IMAGE;
const resource = resolve(repo, "packages/coding-agent/resources/laya/library.jsonl");
const dataset = resolve(workspace, "data/dataset.jsonl");
const modelName = command === "train" || command === "report" ? argument ?? "v4" : command === "register" ? initialModel ?? "v4" : "v4";
if (!/^v[0-9]+(?:-[a-z0-9]+)*$/.test(modelName)) throw new Error("Invalid local model name");
const resultPath = resolve(workspace, `reports/library-${modelName}-result.json`);
const approvalPath = resolve(workspace, "reports/library-label-review-approval.json");
const jsonl = (path) => existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)) : [];
const write = (path, value) => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, value, "utf8");
};

function modelLabelReview(name) {
	const snapshot = resolve(workspace, `jobs/${name}/data/dataset.jsonl`);
	if (!existsSync(snapshot)) return false;
	const rows = jsonl(snapshot).filter((row) => row.source === "library");
	const digest = createHash("sha256").update(rows.map((row) => JSON.stringify(row)).join("\n") + "\n").digest("hex");
	return [approvalPath, resolve(workspace, `reports/library-label-review-approvals/${digest}.json`)].some((path) => {
		if (!existsSync(path)) return false;
		const approval = JSON.parse(readFileSync(path, "utf8"));
		return approval.status === "approved" && approval.datasetSha256 === digest;
	});
}

function boundaryCasesPassed(name) {
	const path = resolve(workspace, `reports/library-${name}-boundaries.json`);
	if (!existsSync(path)) return false;
	const score = JSON.parse(readFileSync(path, "utf8"));
	return score.n === 6 && score.correct === 6;
}

function modelDecisionContract(name) {
	const path = resolve(workspace, `jobs/${name}/decisions.json`);
	if (!existsSync(path)) return false;
	return JSON.stringify(JSON.parse(readFileSync(path, "utf8")).decisions) === JSON.stringify(layaDecisionsFile().decisions);
}

if (command === "prepare") {
	if (!argument) throw new Error("Usage: node scripts/train-laya-library.mjs prepare <library-root>");
	const index = readLibraryIndex(resolve(argument));
	const library = generateLibraryDataset(index);
	if (existsSync(approvalPath)) {
		const approval = JSON.parse(readFileSync(approvalPath, "utf8"));
		if (approval.status === "approved" && typeof approval.datasetSha256 === "string" && /^[a-f0-9]{64}$/.test(approval.datasetSha256)) {
			write(resolve(workspace, `reports/library-label-review-approvals/${approval.datasetSha256}.json`), readFileSync(approvalPath, "utf8"));
		}
	}
	write(resource, library.map((row) => JSON.stringify(row)).join("\n") + "\n");
	const old = jsonl(dataset).filter((row) => row.source !== "library");
	if (!old.length) throw new Error("Existing replay dataset is required; do not fabricate the old held-out split");
	write(dataset, [...old, ...library].map((row) => JSON.stringify(row)).join("\n") + "\n");
	write(resolve(workspace, "decisions.json"), JSON.stringify(layaDecisionsFile(), null, 2) + "\n");
	write(resolve(workspace, "train-library.py"), TRAIN_SCRIPT);
	write(resolve(workspace, "data/boundary-cases.jsonl"), readFileSync(resolve(repo, "packages/coding-agent/resources/laya/boundary-cases.jsonl"), "utf8"));
	console.log(`Prepared ${library.length} library rows and ${old.length} replay rows.`);
} else if (command === "review") {
	const rows = jsonl(resource);
	const boundaries = rows.filter((row) => row.boundary);
	const ordinary = rows.filter((row) => !row.boundary)
		.map((row) => ({ row, hash: createHash("sha256").update(row.state.request).digest("hex") }))
		.sort((left, right) => left.hash.localeCompare(right.hash));
	const cohorts = new Map();
	for (const item of ordinary) {
		const key = item.row.label_source ?? "legacy";
		const cohort = cohorts.get(key) ?? [];
		cohort.push(item);
		cohorts.set(key, cohort);
	}
	const sample = [...cohorts.values()].flatMap((cohort) => cohort.slice(0, Math.ceil(cohort.length / 10))).map(({ row }) => row);
	const selected = [...boundaries, ...sample];
	const digest = createHash("sha256").update(readFileSync(resource)).digest("hex");
	const approval = existsSync(approvalPath) ? JSON.parse(readFileSync(approvalPath, "utf8")) : undefined;
	const approved = approval?.status === "approved" && approval.datasetSha256 === digest;
	const lines = ["# Revisão humana dos rótulos da biblioteca", "", approved ? `Status: rótulos confirmados pelo usuário em ${approval.approvedAt}.` : "Status: pendente de revisão humana.",
		`Dataset SHA-256: ${digest}.`, `Amostra: ${boundaries.length}/${boundaries.length} casos de fronteira e ${sample.length}/${ordinary.length} demais pedidos.`,
		"", "Verifique a categoria dominante de cada pedido conforme o LIBRARY_INDEX.json. Registre correções usando o ID da linha. As categorias seguem o diretório do guia, incluindo REST em web_frontend, Git em devops, SSH em security e refatoração em architecture neste índice.", ""];
	for (const category of [...new Set(selected.map((row) => row.expected.library_category))]) {
		lines.push(`## ${category}`, "");
		for (const row of selected.filter((item) => item.expected.library_category === category)) {
			lines.push(`- **${row.id}** — ${row.split}; ${row.language}; ${row.boundary ? "fronteira" : "amostra"}. ${row.state.request}`);
			if (row.guide) lines.push(`  Guia: ${row.guide}.`);
		}
		lines.push("");
	}
	write(resolve(workspace, "reports/library-label-review.md"), lines.join("\n") + "\n");
	const additional = selected.filter((row) => row.label_source === "agent-short-scenario");
	if (additional.length) {
		const supplement = ["# Revisão dos novos pedidos curtos", "", `Dataset completo SHA-256: ${digest}.`,
			"A aprovação dos 1.130 pedidos anteriores permanece arquivada. Revise apenas estes novos rótulos: todos os 20 casos de fronteira e 18 dos 180 demais pedidos novos.", ""];
		for (const row of additional) supplement.push(`- **${row.id}** — ${row.expected.library_category}; ${row.language}; ${row.boundary ? "fronteira" : "amostra"}. ${row.state.request}`);
		write(resolve(workspace, "reports/library-short-label-review.md"), supplement.join("\n") + "\n");
	}
	console.log(`Prepared ${selected.length} rows for human label review; dataset sha256 ${digest}.`);
} else if (command === "train") {
	if (!image) throw new Error("Set LAYA_TRAIN_IMAGE to an installed CUDA image with laya 0.3.27");
	const recipes = {
		standard: { repeat: "2", batch: "1", accumulation: "16", flags: [] },
		compact: { repeat: "8", batch: "4", accumulation: "4", flags: ["--compact-library", "--freeze-encoder", "--lr-head", "0.00005"] },
		"compact-adapt": { repeat: "4", batch: "8", accumulation: "2", flags: ["--compact-library", "--lr-encoder", "0.000005"] },
		balanced: { repeat: "4", batch: "8", accumulation: "2", flags: ["--compact-library", "--lr-encoder", "0.000005", "--balance-library", "--replay-source-weights", JSON.stringify({ "provider-neutral-policy": 4 })] },
		supervised: { repeat: "8", batch: "8", accumulation: "2", flags: ["--compact-library", "--lr-encoder", "0.00001", "--balance-library", "--library-ce-only", "--replay-source-weights", JSON.stringify({ "provider-neutral-policy": 16 })] },
		"supervised-adapt": { repeat: "4", batch: "8", accumulation: "2", flags: ["--compact-library", "--lr-encoder", "0.000005", "--balance-library", "--library-ce-only", "--replay-source-weights", JSON.stringify({ "provider-neutral-policy": 16 })] },
	};
	if (!Object.hasOwn(recipes, recipe)) throw new Error("Training recipe must be standard, compact, compact-adapt, balanced, supervised or supervised-adapt");
	const options = recipes[recipe];
	const base = initialModel ?? "v3";
	if (!/^v[0-9]+(?:-[a-z0-9]+)*$/.test(base)) throw new Error("Invalid initial model name");
	if (existsSync(resolve(workspace, `models/${modelName}`))) throw new Error(`models/${modelName} already exists; preserve it before retrying`);
	const job = resolve(workspace, `jobs/${modelName}`);
	if (existsSync(job)) throw new Error(`The ${modelName} training snapshot already exists; preserve it before retrying`);
	write(resolve(job, "data/dataset.jsonl"), readFileSync(dataset, "utf8"));
	write(resolve(job, "data/boundary-cases.jsonl"), readFileSync(resolve(repo, "packages/coding-agent/resources/laya/boundary-cases.jsonl"), "utf8"));
	write(resolve(job, "decisions.json"), readFileSync(resolve(workspace, "decisions.json"), "utf8"));
	write(resolve(job, "train.py"), TRAIN_SCRIPT);
	const log = resolve(workspace, `reports/library-${modelName}-progress.log`);
	write(log, "");
	const child = spawn("docker", ["run", "--rm", "--gpus", "all", "--name", `relay-laya-library-${modelName}`,
		"--mount", `type=bind,source=${workspace},target=/workspace`, "--entrypoint", "python", image,
		`/workspace/jobs/${modelName}/train.py`, "learn", "--workspace", `/workspace/jobs/${modelName}`, "--init", `/workspace/models/${base}`,
		"--reference", "/workspace/models/v3", "--out", `/workspace/models/${modelName}`, "--focus-source", "library", "--repeat-focus", options.repeat,
		"--replay-min", "2000", "--replay-max", "2000", "--val-rows", "200",
		"--micro-batch", options.batch, "--grad-accum", options.accumulation, "--low-memory", recipe === "supervised" ? "off" : "on", "--checkpoint-epochs", ...options.flags], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	child.stdout.on("data", (chunk) => { output += chunk; });
	child.stderr.on("data", (chunk) => { appendFileSync(log, chunk); process.stderr.write(chunk); });
	const code = await new Promise((done, reject) => { child.on("error", reject); child.on("close", done); });
	write(resultPath, output.trim() + "\n");
	if (code !== 0) throw new Error(`Training failed with code ${code}: ${output}`);
	console.log(`Training finished. Run node scripts/train-laya-library.mjs report ${modelName}.`);
} else if (command === "evaluate-runtime") {
	if (!image) throw new Error("Set LAYA_TRAIN_IMAGE to the installed Laya image");
	const name = argument ?? "v4";
	if (!/^v[0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error("Invalid local model name");
	if (!existsSync(resolve(workspace, `models/${name}/model.safetensors`))) throw new Error(`Model ${name} is not available yet`);
	write(resolve(workspace, "train_library.py"), TRAIN_SCRIPT);
	write(resolve(workspace, "data/runtime-cases.jsonl"), readFileSync(resolve(repo, "packages/coding-agent/resources/laya/runtime-cases.jsonl"), "utf8"));
	write(resolve(workspace, "data/boundary-cases.jsonl"), readFileSync(resolve(repo, "packages/coding-agent/resources/laya/boundary-cases.jsonl"), "utf8"));
	write(resolve(workspace, "eval-runtime.py"), String.raw`import json
import sys
from pathlib import Path
import laya
from train_library import read_jsonl, score

workspace = Path("/workspace")
name = sys.argv[1]
decisions = workspace / "jobs" / name / "decisions.json"
if not decisions.is_file():
    decisions = workspace / "decisions.json"
decs = json.loads(decisions.read_text(encoding="utf-8"))["decisions"]
rows = read_jsonl(workspace / "data/runtime-cases.jsonl")
agent = laya.load(str(workspace / "models" / name), device="cpu")
result = score(agent, rows, {"library_category": decs["library_category"]})
(workspace / "reports" / ("library-" + name + "-runtime.json")).write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
print(json.dumps(result["library"], ensure_ascii=False))
boundaries = score(agent, read_jsonl(workspace / "data/boundary-cases.jsonl"), {"library_category": decs["library_category"]})
(workspace / "reports" / ("library-" + name + "-boundaries.json")).write_text(json.dumps(boundaries, indent=2, ensure_ascii=False), encoding="utf-8")
print(json.dumps({"acceptance_boundary_correct": boundaries["correct"], "acceptance_boundary_n": boundaries["n"]}))
training_report = workspace / "reports" / ("library-" + name + "-result.json")
if training_report.is_file():
    trained = json.loads(training_report.read_text(encoding="utf-8"))
    if trained.get("ok") and "library" in trained["test"]["candidate"]:
        trained["test"]["candidate"]["library"]["acceptance_boundary"] = {"n": boundaries["n"], "correct": boundaries["correct"]}
        training_report.write_text(json.dumps(trained, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
`);
	const child = spawn("docker", ["run", "--rm", "--mount", `type=bind,source=${workspace},target=/workspace`,
		"--entrypoint", "python", image, "/workspace/eval-runtime.py", name], { cwd: repo, stdio: "inherit" });
	const code = await new Promise((done, reject) => { child.on("error", reject); child.on("close", done); });
	if (code !== 0) throw new Error(`Runtime evaluation failed with code ${code}`);
} else if (command === "register") {
	if (!image || !argument) throw new Error("Set LAYA_TRAIN_IMAGE and pass the runtime Laya home: register <laya-home>");
	const result = JSON.parse(readFileSync(resultPath, "utf8"));
	if (!result.ok || !passesGate(result.test, true)) throw new Error(`The ${modelName} acceptance gate failed; v3 remains active`);
	if (!modelDecisionContract(modelName)) throw new Error("This checkpoint was trained with different decision definitions; retrain with the current runtime contract");
	if (!modelLabelReview(modelName)) throw new Error("This model's training snapshot does not match the human-reviewed library dataset");
	if (!boundaryCasesPassed(modelName)) throw new Error("The six boundary examples from the plan must all pass before model registration");
	if (!existsSync(resolve(workspace, `reports/library-${modelName}-runtime.json`))) throw new Error("Evaluate the separate runtime cases before registering the model");
	const metadata = JSON.parse(readFileSync(resolve(workspace, `models/${modelName}/laya_trainer_meta.json`), "utf8"));
	if (typeof metadata.init !== "string") throw new Error("The checkpoint's initial model is missing from its metadata");
	const basedOn = basename(metadata.init);
	if (!/^v[0-9]+(?:-[a-z0-9]+)*$/.test(basedOn)) throw new Error("Invalid initial model in the checkpoint metadata");
	const target = trainingWorkspace(resolve(argument));
	const registry = existsSync(target.registry) ? JSON.parse(readFileSync(target.registry, "utf8")) : { models: [] };
	if (!Array.isArray(registry.models)) throw new Error("Invalid runtime model registry");
	if (registry.models.some((model) => model.name === modelName)) throw new Error(`${modelName} is already registered; preserve the existing model`);
	write(resolve(workspace, "register-library.py"), String.raw`import shutil
from pathlib import Path

source = Path("/workspace/models/${modelName}")
target = Path("${LAYA_IMAGE_PATHS.trainedModels}/${modelName}")
if not (source / "model.safetensors").is_file():
    raise RuntimeError("The trained model is missing")
if target.exists():
    raise RuntimeError("The volume already contains this model; preserve it before retrying")
shutil.copytree(source, target)
`);
	const child = spawn("docker", ["run", "--rm", "--mount", `type=bind,source=${workspace},target=/workspace,readonly`,
		"--volume", `${LAYA_MODELS_VOLUME}:${LAYA_IMAGE_PATHS.trainedModels}`, "--entrypoint", "python", image,
		"/workspace/register-library.py"], { cwd: repo, stdio: "inherit" });
	const code = await new Promise((done, reject) => { child.on("error", reject); child.on("close", done); });
	if (code !== 0) throw new Error(`Model registration copy failed with code ${code}; registry unchanged`);
	writeRegistry(target, { ...registry, models: [...registry.models, {
		name: modelName, createdAt: new Date().toISOString(), basedOn, sessionTasks: result.rows.focus,
		test: result.test, session: result.focus, seconds: result.seconds, device: result.device,
		libraryMinConfidence: result.library_min_confidence ?? undefined,
	}] });
	console.log(`Registered ${modelName} without switching the active model. Select it with /laya use ${modelName}; roll back with /laya use v3.`);
} else if (command === "report") {
	const result = JSON.parse(readFileSync(resultPath, "utf8"));
	if (!result.ok) throw new Error(result.message);
	const passed = passesGate(result.test, true);
	const metrics = result.test.candidate.library;
	const lines = [`# Laya ${modelName} library evaluation`, "", `Test replacement gate: ${passed ? "PASS" : "FAIL; v3 retained"}.`,
		`Device: ${result.device}; elapsed: ${result.seconds}s.`,
		`Library accuracy: ${metrics.accuracy}; Portuguese: ${metrics.portuguese.correct}/${metrics.portuguese.n}; boundary: ${metrics.boundary.correct}/${metrics.boundary.n}; ECE: ${metrics.ece}.`,
		`Validation-only injection threshold: ${result.library_min_confidence ?? "none; injection disabled"}.`, "",
		`Training definitions match the current runtime: ${modelDecisionContract(modelName) ? "yes" : "no; retraining required before registration"}.`, "",
		`| Decision | v3 correct | ${modelName} correct | Held-out labels |`, "|---|---:|---:|---:|"];
	for (const [id, score] of Object.entries(result.test.candidate.per_question)) {
		lines.push(`| ${id} | ${result.test.current.per_question[id]?.correct ?? "missing"} | ${score.correct} | ${score.n} |`);
	}
	lines.push("", `Human label review for this training snapshot: ${modelLabelReview(modelName) ? "confirmed by the user" : "pending or unmatched dataset"}.`,
		"Synthetic evaluation only. The separate daily-use evaluation uses agent-authored cases, as requested by the user.", "", "## Library mistakes", "");
	for (const prediction of metrics.predictions.filter((item) => !item.correct)) {
		lines.push(`- ${prediction.request}: expected ${prediction.expected}, predicted ${prediction.predicted} (${prediction.confidence.toFixed(3)}).`);
	}
	const runtimePath = resolve(workspace, `reports/library-${modelName}-runtime.json`);
	if (existsSync(runtimePath)) {
		const runtime = JSON.parse(readFileSync(runtimePath, "utf8")).library;
		lines.push("", "## Separate daily-use examples", "", "Source: 30 agent-authored synthetic requests, excluded from training and calibration.",
			`Accuracy: ${runtime.accuracy}; Portuguese: ${runtime.portuguese.correct}/${runtime.portuguese.n}; boundary: ${runtime.boundary.correct}/${runtime.boundary.n}; ECE: ${runtime.ece}.`);
		for (const prediction of runtime.predictions.filter((item) => !item.correct)) {
			lines.push(`- ${prediction.request}: expected ${prediction.expected}, predicted ${prediction.predicted} (${prediction.confidence.toFixed(3)}).`);
		}
	}
	const boundariesPath = resolve(workspace, `reports/library-${modelName}-boundaries.json`);
	lines.push("", "## Named boundary examples from the plan", "", `Acceptance: ${boundaryCasesPassed(modelName) ? "PASS; 6/6 correct" : "pending or failed"}.`);
	if (existsSync(boundariesPath)) {
		for (const prediction of JSON.parse(readFileSync(boundariesPath, "utf8")).library.predictions)
			lines.push(`- ${prediction.correct ? "PASS" : "FAIL"}: ${prediction.request} Expected ${prediction.expected}, predicted ${prediction.predicted}.`);
	}
	write(resolve(workspace, `reports/eval-${modelName}-library.md`), lines.join("\n") + "\n");
	console.log(lines.join("\n"));
	// A report never changes the serving model. Runtime activation uses /laya use after review.
} else {
	throw new Error("Usage: node scripts/train-laya-library.mjs prepare <library-root> | review | train [model] [initial-model] [standard|compact|compact-adapt|balanced|supervised|supervised-adapt] | evaluate-runtime [model] | register <laya-home> [model] | report [model]");
}
