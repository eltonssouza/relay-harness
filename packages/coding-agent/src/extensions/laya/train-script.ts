/**
 * Training script for the routing model. It is built into the Laya Docker image as `train.py`, and
 * `LayaTrainer` runs it in a training container. It is adapted from laya-trainer's
 * `laya_ml.py`; the recipe and the hash split match, so its test split is the one the shipped model
 * never saw.
 */
export const TRAIN_SCRIPT = String.raw`"""Teaches Relay's Laya routing model the exercises of the training workspace.

Relay writes this script to the Laya home and runs it in the Laya Python environment. The recipe is
laya-trainer's: soft targets, a policy-gradient term on noisy logits and soft cross-entropy, then
temperature calibration on the validation split.

Training is incremental. It starts from the model that routes today and mixes the focus exercises
(the ones labeled from sessions) with a replay sample of the other exercises, so the model learns
the new tasks without forgetting the rest. Afterwards the new and the current model answer the
held-out test split, and Relay activates the new model only when it is not worse.

Progress goes to stderr as "PROGRESS <json>" lines. The result is one JSON object on stdout.
"""
import os

os.environ.setdefault("USE_TF", "0")

import argparse
import gc
import hashlib
import json
import math
import random
import re
import sys
import time
from pathlib import Path
from collections import Counter

# Some libraries replace sys.stdout later; writing bytes keeps the output UTF-8 on every platform.
_OUT = getattr(sys.stdout, "buffer", None)
_ERR = getattr(sys.stderr, "buffer", None)


def _write(buf, fallback, text):
    if buf is not None:
        buf.write(text.encode("utf-8"))
        buf.flush()
    else:
        fallback.write(text)
        fallback.flush()


def emit(obj, code=0):
    _write(_OUT, sys.stdout, json.dumps(obj, ensure_ascii=False) + "\n")
    sys.exit(code)


def fail(error, message, **details):
    emit({"ok": False, "error": error, "message": message, **details}, 1)


def progress(**fields):
    _write(_ERR, sys.stderr, "PROGRESS " + json.dumps(fields) + "\n")


# ---------------------------------------------------------------- exercises
def norm(s):
    return re.sub(r"\s+", " ", str(s).strip().lower())


def state_text(row):
    s = row.get("state")
    return s if isinstance(s, str) else json.dumps(s, ensure_ascii=False, sort_keys=True)


def split_of(row):
    """The row's own split, or laya-trainer's fixed 80/10/10 split by text hash."""
    if row.get("split") in ("train", "val", "test"):
        return row["split"]
    h = int(hashlib.sha1(norm(state_text(row)).encode()).hexdigest(), 16) % 100
    return "test" if h < 10 else "val" if h < 20 else "train"


def read_jsonl(path):
    rows = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if line.strip():
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


def compact_library_view(row):
    """A title-free training view of an approved scenario; never change held-out rows or labels."""
    if (row.get("source") != "library" or split_of(row) != "train"
            or row.get("label_source") != "index-agent-scenario"):
        return row
    state = row.get("state")
    if not isinstance(state, dict) or not isinstance(state.get("request"), str):
        return row
    request = state["request"]
    category = (row.get("expected") or {}).get("library_category")
    if category == "frameworks":
        return row  # Framework identity is part of the problem, not an incidental guide citation.
    for separator in (" using ", " usando ", " em um projeto que usa "):
        if separator not in request:
            continue
        problem, subject = request.rsplit(separator, 1)
        problem = problem.rstrip(" .?")
        if category == "languages":
            # Preserve the language identity, but drop edition names and guide descriptions.
            language = "C and C++" if subject.startswith("C and C++") else subject.split()[0]
            problem = language + ": " + problem
        return {**row, "state": {**state, "request": problem + "."}}
    return row


def question(spec):
    q = {"type": spec["type"], "instructions": spec["instructions"]}
    if spec["type"] != "noul" or spec.get("criteria"):
        q["criteria"] = spec["criteria"]
    return q


def target_for(spec, v, smooth=0.02):
    t = spec["type"]
    if t == "choice":
        keys = list(spec["criteria"])
        return [(1 - smooth) * (k == v) + smooth / len(keys) for k in keys]
    if t == "noul":
        y = 1.0 if v else 0.0
        return [(1 - smooth) * (1 - y) + smooth / 2, (1 - smooth) * y + smooth / 2]
    n = len(spec["criteria"])  # score: ordinal target, neighbors get some mass
    p = [0.0] * n
    p[v] = 0.8
    near = [i for i in (v - 1, v + 1) if 0 <= i < n]
    for i in near:
        p[i] += 0.2 / len(near)
    return p


def build_items(tok, cfg, rows, decs):
    from laya.common import QTYPES, build_sequence, render_options

    items, skipped = [], 0
    for r in rows:
        for qid, v in (r.get("expected") or {}).items():
            spec = decs.get(qid)
            if not spec:
                continue
            crit = spec.get("criteria", {} if spec["type"] == "choice" else None)
            q = {"t": spec["type"], "ins": spec["instructions"], "crit": crit}
            target = target_for(spec, v)
            seq, markers = build_sequence(tok, r["state"], q, cfg["max_len"], cfg["head_max_len"])
            if len(markers) != len(render_options({"t": spec["type"], "crit": crit})):
                skipped += 1
                continue
            items.append({"ids": seq, "markers": markers, "qtype": QTYPES[spec["type"]], "target": target,
                          "label": target.index(max(target)), "question_id": qid})
    return items, skipped


def collate(items, pad_id):
    import torch

    b, length = len(items), max(len(i["ids"]) for i in items)
    k_max = max(len(i["markers"]) for i in items)
    ids = torch.full((b, length), pad_id, dtype=torch.long)
    att = torch.zeros((b, length), dtype=torch.long)
    pos = torch.zeros((b, k_max), dtype=torch.long)
    mask = torch.zeros((b, k_max), dtype=torch.bool)
    tgt = torch.zeros((b, k_max))
    for n, it in enumerate(items):
        ids[n, :len(it["ids"])] = torch.tensor(it["ids"])
        att[n, :len(it["ids"])] = 1
        k = len(it["markers"])
        pos[n, :k] = torch.tensor(it["markers"])
        mask[n, :k] = True
        tgt[n, :len(it["target"])] = torch.tensor(it["target"])
    return ids, att, pos, mask, tgt, torch.tensor([i["qtype"] for i in items])


def fit_temperature(samples):
    import torch
    from laya.common import TEMP_MAX, TEMP_MIN

    k_max = max(len(l) for l, _ in samples)
    lg = torch.full((len(samples), k_max), -1e4)
    tg = torch.zeros((len(samples), k_max))
    for i, (l, t) in enumerate(samples):
        lg[i, :len(l)] = torch.as_tensor(l)
        tg[i, :len(t)] = torch.as_tensor(t, dtype=torch.float32)
    lt = torch.zeros(1, requires_grad=True)
    opt = torch.optim.LBFGS([lt], lr=0.1, max_iter=100)

    def closure():
        opt.zero_grad()
        loss = -(tg * torch.log_softmax(lg / lt.exp(), -1)).sum(-1).mean()
        loss.backward()
        return loss

    opt.step(closure)
    return float(torch.clamp(lt.exp(), TEMP_MIN, TEMP_MAX).item())


def save_model(model, tok, cfg, path, meta):
    from safetensors.torch import save_file

    path.mkdir(parents=True, exist_ok=True)
    save_file({k: v.detach().half().cpu().contiguous() for k, v in model.state_dict().items()},
              str(path / "model.safetensors"))
    model.encoder.config.save_pretrained(path / "encoder")
    tok.save_pretrained(path / "tokenizer")
    (path / "rl_agent_config.json").write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    (path / "laya_trainer_meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")


def pick_device(requested):
    import torch

    if requested and requested != "auto":
        return torch.device(requested)
    if torch.cuda.is_available():
        return torch.device("cuda")
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


# ---------------------------------------------------------------- scoring
def predicted_label(spec, ans):
    if spec["type"] == "choice":
        return ans["choice"]
    if spec["type"] == "noul":
        return ans["noul"] >= 0.5
    probs = ans["probabilities"]
    return int(max(probs, key=lambda k: probs[k]))


def score(agent, rows, decs):
    """Correct answers per question, over the rows that label it."""
    per = {}
    library = None
    for qid, spec in decs.items():
        sel = [r for r in rows if qid in (r.get("expected") or {})]
        if not sel:
            continue
        outs = agent.predict_batch([r["state"] for r in sel], {qid: question(spec)}, batch_size=16)
        correct = sum(1 for r, o in zip(sel, outs) if predicted_label(spec, o["answers"][qid]) == r["expected"][qid])
        per[qid] = {"n": len(sel), "correct": correct}
        if qid == "library_category":
            predictions = []
            for r, o in zip(sel, outs):
                ans = o["answers"][qid]
                ok = predicted_label(spec, ans) == r["expected"][qid]
                confidence = float(ans["probabilities"][ans["choice"]])
                predictions.append({"id": r.get("id"), "request": r["state"]["request"],
                                    "expected": r["expected"][qid], "predicted": ans["choice"],
                                    "confidence": confidence, "correct": ok,
                                    "language": r.get("language"), "boundary": r.get("boundary", False)})
            pt = [p for p in predictions if p["language"] == "pt"]
            boundary = [p for p in predictions if p["boundary"]]
            ece = 0.0
            for i in range(10):
                bucket = [p for p in predictions if min(9, int(p["confidence"] * 10)) == i]
                if bucket:
                    ece += abs(sum(p["correct"] for p in bucket) / len(bucket)
                               - sum(p["confidence"] for p in bucket) / len(bucket)) * len(bucket) / len(predictions)
            library = {"accuracy": correct / len(sel), "portuguese": {"n": len(pt), "correct": sum(p["correct"] for p in pt)},
                       "boundary": {"n": len(boundary), "correct": sum(p["correct"] for p in boundary)},
                       "ece": ece, "predictions": predictions}
    result = {"n": sum(m["n"] for m in per.values()), "correct": sum(m["correct"] for m in per.values()),
              "per_question": per}
    if library is not None:
        result["library"] = library
    return result


def library_threshold(metrics):
    """Pick on validation only: at least ten predictions at 95% observed precision."""
    predictions = (metrics.get("library") or {}).get("predictions", [])
    for threshold in [i / 100 for i in range(50, 100)]:
        accepted = [p for p in predictions if p["confidence"] >= threshold]
        if len(accepted) >= 10 and sum(p["correct"] for p in accepted) / len(accepted) >= 0.95:
            return threshold
    return None


# ---------------------------------------------------------------- learn
def cmd_learn(a):
    import torch
    from safetensors.torch import load_file
    from transformers import AutoTokenizer
    from laya.common import build_model, proper_reward

    t0 = time.time()
    replay_weights = json.loads(a.replay_source_weights)
    if not isinstance(replay_weights, dict) or any(
            not isinstance(source, str) or type(weight) is not int or not 1 <= weight <= 32
            for source, weight in replay_weights.items()):
        fail("invalid_replay_weights", "Replay source weights must map source names to integers from 1 to 32.")
    random.seed(a.seed)
    torch.manual_seed(a.seed)
    workspace = Path(a.workspace)
    decs = json.loads((workspace / "decisions.json").read_text(encoding="utf-8"))["decisions"]
    rows = [r for r in read_jsonl(workspace / "data" / "dataset.jsonl") if r.get("expected")]
    focus = [r for r in rows if r.get("source") == a.focus_source and split_of(r) == "train"]
    rest = [r for r in rows if r.get("source") != a.focus_source]
    if not focus:
        fail("no_focus", "There are no '%s' exercises to learn." % a.focus_source)
    pool = [r for r in rest if split_of(r) == "train"]
    val = [r for r in rows if split_of(r) == "val"]
    # Keep library validation rows even when an older replay dataset fills the cap.
    val = [r for r in val if "library_category" in r.get("expected", {})] + [
        r for r in val if "library_category" not in r.get("expected", {})][:a.val_rows]
    test = [r for r in rows if split_of(r) == "test"]
    replay_n = min(len(pool), max(a.replay_min, min(a.replay_max, a.replay_ratio * len(focus))))
    replay = random.Random(a.seed).sample(pool, replay_n)

    init = Path(a.init)
    out = Path(a.out)
    device = pick_device(a.device)
    low_memory = a.low_memory == "on" or (
        a.low_memory == "auto" and device.type == "cuda"
        and torch.cuda.get_device_properties(device).total_memory < 12 * 1024 ** 3)
    cfg = json.loads((init / "rl_agent_config.json").read_text(encoding="utf-8"))
    cfg["gradient_checkpointing"] = True
    tok = AutoTokenizer.from_pretrained(str(init / "tokenizer"))
    training_focus = [compact_library_view(row) if a.compact_library and repeat % 2 else row
                      for repeat in range(a.repeat_focus) for row in focus]
    weighted_replay = [row for row in replay for _ in range(replay_weights.get(row.get("source"), 1))]
    train_items, skipped = build_items(tok, cfg, training_focus + weighted_replay, decs)
    library_weights = {}
    if a.balance_library:
        counts = Counter(row["expected"]["library_category"] for row in focus
                         if "library_category" in row["expected"])
        library_weights = {category: sum(counts.values()) / (len(counts) * count)
                           for category, count in counts.items()}
        keys = list(decs["library_category"]["criteria"])
        for item in train_items:
            if item["question_id"] == "library_category":
                item["weight"] = library_weights.get(keys[item["label"]], 1.0)
    val_items, _ = build_items(tok, cfg, val, decs)
    if not train_items:
        fail("no_items", "No exercise fits the model input.")

    model = build_model(cfg, encoder_dir=str(init / "encoder"))
    model.load_state_dict(load_file(str(init / "model.safetensors")), strict=True)
    model.float()
    model.encoder.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    model.head_checkpointing = True
    if a.freeze_encoder:
        for n, p in model.named_parameters():
            if "encoder." in n:
                p.requires_grad_(False)
    elif low_memory:  # freeze the embeddings and the lower half of the encoder: less optimizer memory
        layers = max((int(m.group(1)) for n, _ in model.named_parameters()
                      if (m := re.search(r"layers\.(\d+)\.", n)) and "encoder." in n), default=-1) + 1
        for n, p in model.named_parameters():
            m = re.search(r"layers\.(\d+)\.", n)
            if "encoder." in n and ("embeddings" in n or (m and int(m.group(1)) < layers // 2)):
                p.requires_grad_(False)
    model.to(device).train()
    use_amp = device.type == "cuda" and torch.cuda.is_bf16_supported()

    enc = [p for n, p in model.named_parameters() if "encoder." in n and p.requires_grad]
    head = [p for n, p in model.named_parameters() if "encoder." not in n]
    opt = torch.optim.AdamW([{"params": enc, "lr": a.lr_encoder}, {"params": head, "lr": a.lr_head}],
                            weight_decay=0.01)
    updates = max(1, math.ceil(len(train_items) / a.micro_batch / a.grad_accum) * a.epochs)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=updates, eta_min=1e-6)

    def forward(chunk):
        ids, att, pos, mask, tgt, qt = [t.to(device) for t in collate(chunk, tok.pad_token_id)]
        with torch.autocast(device.type, dtype=torch.bfloat16, enabled=use_amp):
            logits, act = model(ids, att, pos, mask, qt)
        return logits.float(), act, mask, tgt, qt

    def evaluate(items):
        model.eval()
        loss = correct = 0
        with torch.no_grad():
            for s in range(0, len(items), a.micro_batch):
                chunk = items[s:s + a.micro_batch]
                lg, _, mask, tgt, _ = forward(chunk)
                lp = torch.log_softmax(lg.masked_fill(~mask, -1e4), -1)
                loss += -(tgt * lp).sum(-1).sum().item()
                correct += (lp.argmax(-1).cpu() == torch.tensor([i["label"] for i in chunk])).sum().item()
        model.train()
        return loss / max(1, len(items)), correct / max(1, len(items))

    steps = math.ceil(len(train_items) / a.micro_batch)
    every = max(1, steps // 10)
    history = []
    progress(phase="train", epoch=0, epochs=a.epochs, done=0, device=device.type, low_memory=low_memory,
             items=len(train_items))
    try:
        for ep in range(a.epochs):
            random.Random(a.seed + ep).shuffle(train_items)
            opt.zero_grad(set_to_none=True)
            sigma = 0.4 + (0.1 - 0.4) * ep / max(1, a.epochs - 1)
            total = batches = 0
            started = time.time()
            for s in range(0, len(train_items), a.micro_batch):
                chunk = train_items[s:s + a.micro_batch]
                lg, act, mask, tgt, qt = forward(chunk)
                k = mask.sum(-1, keepdim=True).float()
                eps = torch.randn((4,) + lg.shape, device=device) * sigma * mask
                eps = (eps - eps.sum(-1, keepdim=True) / k) * mask
                noisy = lg.detach().unsqueeze(0) + eps
                probs = torch.softmax(noisy.masked_fill(~mask, -1e4), -1)
                with torch.no_grad():
                    reward = proper_reward(probs, tgt.unsqueeze(0), qt, mask, w_sph=0.75, w_rps=1.0)
                    adv = reward - reward.mean(0, keepdim=True)
                    adv = adv / (adv.std() + 1e-6)
                logp = -(((noisy - lg.unsqueeze(0)) ** 2) * mask).sum(-1) / (2 * sigma ** 2)
                loss_rl = -(adv * logp).mean(0)
                if a.library_ce_only:
                    loss_rl = loss_rl * torch.tensor([item["question_id"] != "library_category" for item in chunk], device=device)
                loss_ce = -(tgt * torch.log_softmax(lg.masked_fill(~mask, -1e4), -1)).sum(-1)
                weights = torch.tensor([item.get("weight", 1.0) for item in chunk], device=device)
                loss = ((weights * (loss_rl + loss_ce)).mean() + 0.0 * act.sum()) / a.grad_accum
                loss.backward()
                batches += 1
                total += loss.item() * a.grad_accum
                if batches % a.grad_accum == 0 or s + a.micro_batch >= len(train_items):
                    torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                    opt.step()
                    sched.step()
                    opt.zero_grad(set_to_none=True)
                if batches % every == 0 and batches < steps:
                    done = batches / steps
                    elapsed = time.time() - started
                    progress(phase="train", epoch=ep + 1, epochs=a.epochs, done=round(done, 3),
                             eta_s=round(elapsed / done * (1 - done) + (a.epochs - ep - 1) * elapsed / done))
            val_loss, val_acc = evaluate(val_items) if val_items else (total / batches, None)
            history.append({"epoch": ep + 1, "train_loss": round(total / batches, 4), "val_loss": round(val_loss, 4),
                            "val_acc": None if val_acc is None else round(val_acc, 4)})
            if a.checkpoint_epochs:
                checkpoint = out.parent / (out.name + "-epoch-" + str(ep + 1))
                if checkpoint.exists():
                    fail("checkpoint_exists", "Preserve the existing epoch checkpoint before retrying.", path=str(checkpoint))
                save_model(model, tok, cfg, checkpoint, {
                    "version": checkpoint.name, "init": str(init), "reference": a.reference or str(init),
                    "epochs": ep + 1, "history": history, "calibrated": False,
                    "dataset_sha256": hashlib.sha256((workspace / "data" / "dataset.jsonl").read_bytes()).hexdigest(),
                    "compact_library_views": a.compact_library, "encoder_frozen": a.freeze_encoder,
                    "library_class_weights": library_weights, "replay_source_weights": replay_weights,
                    "library_ce_only": a.library_ce_only,
                })
            progress(phase="train", epoch=ep + 1, epochs=a.epochs, done=1, val_acc=history[-1]["val_acc"])
    except torch.cuda.OutOfMemoryError:
        fail("out_of_memory", "The GPU ran out of memory while training.")

    model.eval()
    samples = [[], [], []]
    with torch.no_grad():
        for s in range(0, len(val_items), a.micro_batch):
            chunk = val_items[s:s + a.micro_batch]
            lg, _, _, _, _ = forward(chunk)
            for i, it in enumerate(chunk):
                samples[it["qtype"]].append((lg[i, :len(it["markers"])].cpu(), it["target"]))
    previous = cfg.get("temperature") or [1.0, 1.0, 1.0]
    cfg["temperature"] = [fit_temperature(g) if len(g) >= 10 else previous[i] for i, g in enumerate(samples)]
    cfg.pop("temperature_by_options", None)
    cfg["fine_tuned"] = True
    meta = {"version": out.name, "init": str(init), "epochs": a.epochs, "history": history,
            "reference": a.reference or str(init),
            "dataset_sha256": hashlib.sha256((workspace / "data" / "dataset.jsonl").read_bytes()).hexdigest(),
            "temperatures": cfg["temperature"],
            "rows": {"focus": len(focus), "replay": len(replay), "val": len(val), "test": len(test)},
            "items": {"train": len(train_items), "val": len(val_items), "skipped": skipped},
            "device": device.type, "low_memory": low_memory, "created": time.strftime("%Y-%m-%d %H:%M:%S")}
    meta["compact_library_views"] = a.compact_library
    meta["encoder_frozen"] = a.freeze_encoder
    meta["library_class_weights"] = library_weights
    meta["replay_source_weights"] = replay_weights
    meta["library_ce_only"] = a.library_ce_only
    save_model(model, tok, cfg, out, meta)
    del model, opt, sched
    gc.collect()
    if device.type == "cuda":
        torch.cuda.empty_cache()

    import laya

    progress(phase="evaluate", model="new")
    agent = laya.load(str(out), device=device.type)
    candidate = score(agent, test, decs)
    if "library" in candidate:
        boundaries = score(agent, read_jsonl(workspace / "data" / "boundary-cases.jsonl"),
                           {"library_category": decs["library_category"]})
        candidate["library"]["acceptance_boundary"] = {"n": boundaries["n"], "correct": boundaries["correct"]}
    validation = score(agent, val, decs)
    threshold = library_threshold(validation)
    learned = score(agent, focus, decs)
    del agent
    gc.collect()
    progress(phase="evaluate", model="current")
    agent = laya.load(a.reference or str(init), device=device.type)
    current = score(agent, test, decs)
    before = score(agent, focus, decs)
    emit({"ok": True, "model": str(out), "seconds": round(time.time() - t0), "device": device.type,
          "low_memory": low_memory, "rows": meta["rows"], "history": history,
          "test": {"candidate": candidate, "current": current},
          "validation": validation, "library_min_confidence": threshold,
          "focus": {"candidate": learned, "current": before}})


def main():
    ap = argparse.ArgumentParser(description="Teach Relay's Laya routing model")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("learn")
    p.add_argument("--workspace", required=True, help="folder with decisions.json and data/dataset.jsonl")
    p.add_argument("--init", required=True, help="model to start from")
    p.add_argument("--reference", help="unchanged acceptance baseline; defaults to the initial model")
    p.add_argument("--out", required=True, help="folder of the new model")
    p.add_argument("--focus-source", default="session")
    p.add_argument("--repeat-focus", type=int, default=4)
    p.add_argument("--replay-min", type=int, default=100)
    p.add_argument("--replay-ratio", type=int, default=4)
    p.add_argument("--replay-max", type=int, default=600)
    p.add_argument("--val-rows", type=int, default=100)
    p.add_argument("--epochs", type=int, default=3)
    p.add_argument("--micro-batch", type=int, default=2)
    p.add_argument("--grad-accum", type=int, default=8)
    p.add_argument("--lr-encoder", type=float, default=2e-5)
    p.add_argument("--lr-head", type=float, default=1e-4)
    p.add_argument("--low-memory", default="auto", choices=["auto", "on", "off"])
    p.add_argument("--compact-library", action="store_true", help="alternate approved library scenarios with compact training views")
    p.add_argument("--freeze-encoder", action="store_true", help="train only the decision head, preserving encoder representations")
    p.add_argument("--balance-library", action="store_true", help="balance library loss using training category counts")
    p.add_argument("--library-ce-only", action="store_true", help="use supervised cross-entropy without policy-gradient noise for library labels")
    p.add_argument("--replay-source-weights", default="{}", help="JSON object of training replay source repetition counts")
    p.add_argument("--checkpoint-epochs", action="store_true", help="save uncalibrated recovery models after each epoch, without activation")
    p.add_argument("--device", default="auto")
    p.add_argument("--seed", type=int, default=7)
    p.set_defaults(f=cmd_learn)
    a = ap.parse_args()
    a.f(a)


if __name__ == "__main__":
    main()
`;
