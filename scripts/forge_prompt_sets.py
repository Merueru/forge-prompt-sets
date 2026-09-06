import base64
import html
import json
import os
import re
import urllib.parse
from datetime import datetime
from io import BytesIO

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from PIL import Image

from modules import script_callbacks, shared, ui_extra_networks


EXTENSION_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PROMPT_SETS_DIR = os.path.join(EXTENSION_DIR, "prompt_sets")
ENDPOINT_BASE = "/forge-prompt-sets"
MAX_PREVIEW_BYTES = 25 * 1024 * 1024
ADD_CARD_ID = "__forge_prompt_sets_add__"


def ensure_dirs():
    os.makedirs(PROMPT_SETS_DIR, exist_ok=True)


def now_iso():
    return datetime.now().isoformat(timespec="seconds")


def js_string(value):
    return json.dumps(value or "", ensure_ascii=False)


def safe_filename(name):
    name = (name or "").strip()
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name)
    name = re.sub(r"\s+", "_", name)
    name = name.strip("._ ")
    if not name:
        name = "prompt_set_" + datetime.now().strftime("%Y%m%d_%H%M%S")
    return name[:96]


def safe_path_part(name):
    name = (name or "").strip()
    if not name:
        return ""
    return safe_filename(name)


def safe_rel_path(value):
    parts = []
    for part in re.split(r"[\\/]+", value or ""):
        part = safe_path_part(part)
        if part:
            parts.append(part)
    return "/".join(parts)


def path_inside(base, target):
    base = os.path.abspath(base)
    target = os.path.abspath(target)
    try:
        return os.path.commonpath([base, target]) == base
    except ValueError:
        return False


def json_path_for_id(prompt_set_id):
    rel_id = safe_rel_path(prompt_set_id)
    if not rel_id:
        raise ValueError("Prompt set path is empty")
    path = os.path.join(PROMPT_SETS_DIR, *rel_id.split("/")) + ".json"
    if not path_inside(PROMPT_SETS_DIR, path):
        raise ValueError("Invalid prompt set path")
    return path


def prompt_set_id_from_path(path):
    rel = os.path.relpath(path, PROMPT_SETS_DIR)
    return os.path.splitext(rel)[0].replace("\\", "/")


def preview_path_for_id(prompt_set_id):
    rel_id = safe_rel_path(prompt_set_id)
    if not rel_id:
        raise ValueError("Preview path is empty")
    path = os.path.join(PROMPT_SETS_DIR, *rel_id.split("/")) + ".preview.png"
    if not path_inside(PROMPT_SETS_DIR, path):
        raise ValueError("Invalid preview path")
    return path


def preview_url_for_id(prompt_set_id):
    path = preview_path_for_id(prompt_set_id)
    if not os.path.exists(path):
        return ""
    quoted = urllib.parse.quote(path.replace("\\", "/"))
    mtime = int(os.path.getmtime(path))
    return f"./sd_extra_networks/thumb?filename={quoted}&mtime={mtime}"


def list_prompt_set_ids():
    ensure_dirs()
    rel_ids = []
    for root, _, files in os.walk(PROMPT_SETS_DIR):
        for filename in files:
            if not filename.lower().endswith(".json"):
                continue
            rel_ids.append(prompt_set_id_from_path(os.path.join(root, filename)))
    return sorted(rel_ids, key=shared.natural_sort_key)


def list_folders():
    folders = set()
    for prompt_set_id in list_prompt_set_ids():
        folder = os.path.dirname(prompt_set_id).replace("\\", "/")
        while folder:
            folders.add(folder)
            folder = os.path.dirname(folder).replace("\\", "/")
    return sorted(folders, key=shared.natural_sort_key)


def folder_search_terms(folder):
    folder = (folder or "").replace("\\", "/").strip("/")
    if not folder:
        return []

    terms = {folder, folder + "/"}
    terms.add(folder.replace("/", "\\"))
    terms.add(folder.replace("/", "\\") + "\\")
    return sorted(terms, key=shared.natural_sort_key)


def load_prompt_set(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as exc:
        print(f"[ForgePromptSets] Failed to read {path}: {exc}")
        return None

    if not isinstance(data, dict):
        return None

    data.setdefault("id", os.path.splitext(os.path.basename(path))[0])
    data.setdefault("name", data["id"])
    data.setdefault("prompt", "")
    data.setdefault("negative_prompt", "")
    data.setdefault("description", "")
    data.setdefault("folder", "")
    data.setdefault("tags", [])
    return data


def save_preview_data_url(prompt_set_id, data_url):
    if not data_url:
        return None

    if "," not in data_url:
        raise ValueError("Preview image is not a data URL")

    header, encoded = data_url.split(",", 1)
    if not header.startswith("data:image/"):
        raise ValueError("Preview must be an image")

    raw = base64.b64decode(encoded, validate=True)
    if len(raw) > MAX_PREVIEW_BYTES:
        raise ValueError("Preview image is too large")

    image = Image.open(BytesIO(raw))
    image.thumbnail((768, 768))

    preview_path = preview_path_for_id(prompt_set_id)
    os.makedirs(os.path.dirname(preview_path), exist_ok=True)
    image.save(preview_path, "PNG")
    return preview_path


def save_prompt_set(payload):
    ensure_dirs()

    name = (payload.get("name") or "").strip()
    prompt = payload.get("prompt") or ""
    negative_prompt = payload.get("negative_prompt") or ""
    description = payload.get("description") or ""
    tags_text = payload.get("tags") or ""
    folder = safe_rel_path(payload.get("folder") or "")
    original_id = safe_rel_path(payload.get("original_id") or "")

    original_data = {}
    if original_id:
        original_path = json_path_for_id(original_id)
        if os.path.exists(original_path):
            original_data = load_prompt_set(original_path) or {}

    if not name:
        name = (original_data.get("name") or (prompt.strip().splitlines() or ["Prompt Set"])[0])[:48]

    prompt_set_id = "/".join([x for x in [folder, safe_filename(name)] if x])
    path = json_path_for_id(prompt_set_id)
    os.makedirs(os.path.dirname(path), exist_ok=True)

    existing = load_prompt_set(path) if os.path.exists(path) else original_data
    created_at = existing.get("created_at") if isinstance(existing, dict) else None

    tags = [tag.strip() for tag in re.split(r"[,#\n]", tags_text) if tag.strip()]

    data = {
        "id": prompt_set_id,
        "name": name,
        "folder": folder,
        "prompt": prompt,
        "negative_prompt": negative_prompt,
        "description": description,
        "tags": tags,
        "created_at": created_at or now_iso(),
        "updated_at": now_iso(),
    }

    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

    preview_data_url = payload.get("preview_data_url")
    if preview_data_url:
        save_preview_data_url(prompt_set_id, payload["preview_data_url"])
    elif original_id and original_id != prompt_set_id:
        old_preview_path = preview_path_for_id(original_id)
        new_preview_path = preview_path_for_id(prompt_set_id)
        if os.path.exists(old_preview_path):
            os.makedirs(os.path.dirname(new_preview_path), exist_ok=True)
            os.replace(old_preview_path, new_preview_path)

    if original_id and original_id != prompt_set_id:
        delete_prompt_set(original_id, missing_ok=True)

    return data


def delete_prompt_set(prompt_set_id, missing_ok=False):
    prompt_set_id = safe_rel_path(prompt_set_id)
    path = json_path_for_id(prompt_set_id)
    preview_path = preview_path_for_id(prompt_set_id)

    removed = False
    for target in [path, preview_path]:
        if os.path.exists(target):
            os.remove(target)
            removed = True

    if not removed and not missing_ok:
        raise FileNotFoundError(prompt_set_id)

    cleanup_empty_dirs()
    return removed


def cleanup_empty_dirs():
    for root, dirs, files in os.walk(PROMPT_SETS_DIR, topdown=False):
        if root == PROMPT_SETS_DIR:
            continue
        if dirs or files:
            continue
        try:
            os.rmdir(root)
        except OSError:
            pass


class PromptSetsPage(ui_extra_networks.ExtraNetworksPage):
    def __init__(self):
        super().__init__("Prompt Sets")
        self.allow_negative_prompt = True
        self.btn_copy_path_tpl = ""
        self.btn_metadata_tpl = ""
        self.btn_edit_item_tpl = ""

    def refresh(self):
        ensure_dirs()

    def allowed_directories_for_previews(self):
        ensure_dirs()
        return [PROMPT_SETS_DIR]

    def create_item(self, name, index=None, enable_filter=True):
        if name == ADD_CARD_ID:
            return {
                "name": ADD_CARD_ID,
                "filename": os.path.join(PROMPT_SETS_DIR, ADD_CARD_ID),
                "shorthash": "",
                "preview": None,
                "description": "",
                "search_terms": ["add prompt set create new"],
                "prompt": js_string(""),
                "negative_prompt": js_string(""),
                "local_preview": os.path.join(PROMPT_SETS_DIR, ADD_CARD_ID + ".preview.png"),
                "metadata": {},
                "sort_keys": {"default": -1, "name": "", "path": ""},
                "is_add_card": True,
            }

        path = json_path_for_id(name)
        data = load_prompt_set(path)
        if not data:
            return None

        prompt_set_id = safe_rel_path(name)
        folder = data.get("folder") or os.path.dirname(prompt_set_id).replace("\\", "/")
        stem = os.path.splitext(path)[0]
        tags = data.get("tags") or []
        if isinstance(tags, str):
            tags = [tags]

        search_terms = [
            data.get("name", ""),
            *folder_search_terms(folder),
            data.get("prompt", ""),
            data.get("negative_prompt", ""),
            data.get("description", ""),
            " ".join(tags),
        ]

        metadata = {
            "prompt": data.get("prompt", ""),
            "negative_prompt": data.get("negative_prompt", ""),
            "tags": ", ".join(tags),
        }

        return {
            "name": data.get("name") or name,
            "prompt_set_id": prompt_set_id,
            "folder": folder,
            "prompt_text": data.get("prompt", ""),
            "negative_prompt_text": data.get("negative_prompt", ""),
            "filename": path,
            "shorthash": "",
            "preview": self.find_preview(stem),
            "description": data.get("description", ""),
            "search_terms": search_terms,
            "prompt": js_string(data.get("prompt", "")),
            "negative_prompt": js_string(data.get("negative_prompt", "")),
            "local_preview": f"{stem}.preview.{shared.opts.samples_format}",
            "metadata": metadata,
            "sort_keys": {"default": index, **self.get_sort_keys(path)},
        }

    def list_items(self):
        ensure_dirs()
        yield self.create_item(ADD_CARD_ID, -1)

        for index, rel_id in enumerate(list_prompt_set_ids()):
            item = self.create_item(rel_id, index)
            if item is not None:
                yield item

    def create_item_html(self, tabname, item, template=None):
        # Tree view asks for the template arguments, while the card grid asks
        # for rendered HTML. Preserve the base-class contract for tree items.
        if template is None and not item.get("is_add_card"):
            return super().create_item_html(tabname, item)

        if item.get("is_add_card"):
            onclick = html.escape(f"forgePromptSetsOpen(event, '{tabname}')")
            if template is None:
                return {
                    "background_image": "",
                    "card_clicked": onclick,
                    "copy_path_button": "",
                    "description": "Create from current prompt",
                    "edit_button": "",
                    "local_preview": js_string(item["local_preview"]),
                    "metadata_button": "",
                    "name": "+ Prompt Set",
                    "prompt": js_string(""),
                    "save_card_preview": "",
                    "search_only": "",
                    "search_terms": "<span class='hidden search_terms'>add prompt set create new</span>",
                    "sort_keys": "data-sort-default=\"-1\" data-sort-name=\"\" data-sort-path=\"\"",
                    "style": "",
                    "tabname": tabname,
                    "extra_networks_tabname": self.extra_networks_tabname,
                }

            style_height = f"height: {shared.opts.extra_networks_card_height}px;" if shared.opts.extra_networks_card_height else ""
            style_width = f"width: {shared.opts.extra_networks_card_width}px;" if shared.opts.extra_networks_card_width else ""
            style_font_size = f"font-size: {shared.opts.extra_networks_card_text_scale*100}%;"
            style = style_height + style_width + style_font_size
            return f"""
            <div class="card forge-prompt-sets-add-card" style="{style}" onclick="{onclick}" title="Create a new prompt set" aria-label="Create a new prompt set" data-no-favorite="true" data-no-random="true" data-name="add prompt set" data-sort-default="-1" data-sort-name="" data-sort-path="" data-sort-date_created="0" data-sort-date_modified="0">
                <div class="forge-prompt-sets-add-content">
                    <div class="forge-prompt-sets-add-symbol">+</div>
                    <span class="forge-prompt-sets-add-title">Prompt Set</span>
                </div>
                <span class="hidden search_terms">add prompt set create new</span>
            </div>
            """

        prompt_set_id = item.get("prompt_set_id", "")
        prompt = item.get("prompt_text", "")
        negative_prompt = item.get("negative_prompt_text", "")
        folder = item.get("folder", "")
        onclick = html.escape(
            f"forgePromptSetsToggleCard(event, '{tabname}', {js_string(prompt_set_id)}, {js_string(prompt)}, {js_string(negative_prompt)});"
        )
        edit_onclick = html.escape(
            f"forgePromptSetsEdit(event, '{tabname}', {js_string(prompt_set_id)})"
        )
        delete_onclick = html.escape(
            f"forgePromptSetsDelete(event, '{tabname}', {js_string(prompt_set_id)})"
        )

        preview = item.get("preview")
        if preview:
            preview_html = f'<img src="{html.escape(preview)}" class="preview" loading="lazy">'
        else:
            preview_html = '<div class="forge-prompt-set-empty-preview">Prompt Set</div>'

        style_height = f"height: {shared.opts.extra_networks_card_height}px;" if shared.opts.extra_networks_card_height else ""
        style_width = f"width: {shared.opts.extra_networks_card_width}px;" if shared.opts.extra_networks_card_width else ""
        style_font_size = f"font-size: {shared.opts.extra_networks_card_text_scale*100}%;"
        style = style_height + style_width + style_font_size

        item_sort_keys = item.get("sort_keys", {})
        sort_keys = " ".join(
            f'data-sort-{k}="{html.escape(str(v))}"'
            for k, v in item_sort_keys.items()
        )
        search_terms_html = "".join(
            f"<span class='hidden search_terms'>{html.escape(str(term))}</span>"
            for term in item.get("search_terms", [])
        )

        description = item.get("description") or folder
        edit_icon = """
                <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M4 20h4.2L19.6 8.6a2 2 0 0 0 0-2.8l-1.4-1.4a2 2 0 0 0-2.8 0L4 15.8V20z"></path>
                    <path d="M13.8 6 18 10.2"></path>
                </svg>
        """
        delete_icon = """
                <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M5 7h14"></path>
                    <path d="M10 11v6"></path>
                    <path d="M14 11v6"></path>
                    <path d="M8 7l1-3h6l1 3"></path>
                    <path d="M7 7l1 13h8l1-13"></path>
                </svg>
        """
        return f"""
        <div class="card forge-prompt-set-card" style="{style}" onclick="{onclick}" data-prompt-set-id="{html.escape(prompt_set_id)}" data-name="{html.escape(item.get('name', ''))}" {sort_keys}>
            {preview_html}
            <div class="forge-prompt-set-buttons">
                <button type="button" class="forge-prompt-set-icon-btn forge-prompt-set-edit" title="Edit prompt set" aria-label="Edit prompt set" onclick="{edit_onclick}">{edit_icon}</button>
                <button type="button" class="forge-prompt-set-icon-btn forge-prompt-set-delete" title="Delete prompt set" aria-label="Delete prompt set" onclick="{delete_onclick}">{delete_icon}</button>
            </div>
            <div class="actions">
                <div class="additional">{search_terms_html}</div>
                <span class="name">{html.escape(item.get("name", ""))}</span>
                <span class="description">{html.escape(description)}</span>
            </div>
        </div>
        """


class PromptSetsRoutes:
    @staticmethod
    def register(app: FastAPI):
        def render_card_html(prompt_set_id, tabname):
            page = PromptSetsPage()
            item = page.create_item(prompt_set_id)
            if not item:
                raise FileNotFoundError(prompt_set_id)
            return page.create_item_html(tabname or "txt2img", item)

        @app.post(f"{ENDPOINT_BASE}/save")
        async def save(request: Request):
            try:
                payload = await request.json()
                data = save_prompt_set(payload)
                card_html = ""
                try:
                    card_html = render_card_html(data["id"], payload.get("tabname", ""))
                except Exception as render_exc:
                    print(f"[ForgePromptSets] Card render after save failed: {render_exc}")
                return JSONResponse({"ok": True, "item": data, "html": card_html})
            except Exception as exc:
                print(f"[ForgePromptSets] Save failed: {exc}")
                return JSONResponse({"ok": False, "error": str(exc)}, status_code=400)

        @app.get(f"{ENDPOINT_BASE}/card")
        async def card(request: Request):
            try:
                prompt_set_id = request.query_params.get("id", "")
                tabname = request.query_params.get("tabname", "txt2img")
                return JSONResponse({"ok": True, "html": render_card_html(prompt_set_id, tabname)})
            except Exception as exc:
                print(f"[ForgePromptSets] Card render failed: {exc}")
                return JSONResponse({"ok": False, "error": str(exc)}, status_code=404)

        @app.get(f"{ENDPOINT_BASE}/item")
        async def get_item(request: Request):
            try:
                prompt_set_id = request.query_params.get("id", "")
                path = json_path_for_id(prompt_set_id)
                data = load_prompt_set(path)
                if not data:
                    raise FileNotFoundError(prompt_set_id)
                data["id"] = safe_rel_path(prompt_set_id)
                data["folder"] = data.get("folder") or os.path.dirname(data["id"]).replace("\\", "/")
                data["preview_url"] = preview_url_for_id(prompt_set_id)
                return JSONResponse({"ok": True, "item": data})
            except Exception as exc:
                print(f"[ForgePromptSets] Get failed: {exc}")
                return JSONResponse({"ok": False, "error": str(exc)}, status_code=404)

        @app.post(f"{ENDPOINT_BASE}/delete")
        async def delete(request: Request):
            try:
                payload = await request.json()
                delete_prompt_set(payload.get("id", ""))
                return JSONResponse({"ok": True})
            except Exception as exc:
                print(f"[ForgePromptSets] Delete failed: {exc}")
                return JSONResponse({"ok": False, "error": str(exc)}, status_code=400)

        @app.get(f"{ENDPOINT_BASE}/folders")
        async def folders():
            return JSONResponse({"ok": True, "folders": list_folders()})


def register_page():
    ensure_dirs()
    ui_extra_networks.register_page(PromptSetsPage())


script_callbacks.on_before_ui(register_page)
script_callbacks.on_app_started(lambda demo, app: PromptSetsRoutes.register(app))
