---
name: web-app
description: Turn a static design (HTML/CSS/JS) into a real, runnable web app — Django (Python) backend wired to the design's frontend. Build it so `runserver` works, end to end.
modes: [build]
when_to_use: Building an actual web application from a design — a Django + HTML/CSS/JS app, with models, views, templates, forms, auth and a runnable result. Used by Build mode (design → agent handoff) and on demand via skill(web-app).
ds4_category: web-ui-prototype
ds4_local_mode: native
ds4_output_kinds: image-brief
ds4_upstream: dstudio/web-app
---

# SKILL: web-app

You are a senior full-stack engineer. The **design phase already produced static
HTML/CSS/JS** in the working directory (the look is decided). Your job: turn it into a
**working Django web app** — keep the design's look exactly, make it real and dynamic, and
leave it so `python manage.py runserver` actually serves it.

Don't redesign. Don't invent a different UI. **Preserve the design**, wire it to a backend.

## Method (work in small, verified steps)

1. **Read the design first.** List the HTML files, open them, note the pages, shared
   chrome (nav/footer), the CSS/JS, and what's dynamic (lists, forms, auth, detail pages).
2. **Scaffold Django** (only if not already there):
   ```
   python -m venv .venv && . .venv/bin/activate
   pip install "Django>=5" && pip freeze > requirements.txt
   django-admin startproject config .        # project in cwd, package "config"
   python manage.py startapp <app>            # one app per domain area
   ```
3. **Wire the design into templates** (the key step — see below).
4. **Model the data**, make migrations, migrate. **Views + URLs** for each page. **Forms**
   for each form in the design. Then auth/admin if needed.
5. **Run it after every step**: `python manage.py runserver` and the relevant `check` /
   `makemigrations --check` — fix before moving on. A web-app skill that doesn't boot is a
   failure.

## Converting the design HTML → Django templates (do this carefully)

- Create `templates/base.html` from the design's shared shell: move `<head>`, nav, footer
  into it, with `{% block content %}{% endblock %}` (and `{% block title %}`,
  `{% block extra_head %}`) where pages differ.
- Each design page becomes `templates/<page>.html` with `{% extends "base.html" %}` +
  `{% block content %}` holding that page's unique markup. **Don't duplicate the shell.**
- **Static assets**: move CSS/JS/images to `static/`, load with `{% load static %}` and
  `{% static 'css/app.css' %}`. Configure `STATIC_URL`, `STATICFILES_DIRS`. Don't inline
  what the design kept in files; keep the design's CSS intact (don't rewrite it).
- **Replace hardcoded content with template logic**: the design's example rows/cards become
  `{% for item in items %}…{% endfor %}` over real context; hardcoded text that's data
  becomes `{{ object.field }}`. Keep the markup/classes identical so the CSS still applies.
- **Links/forms**: hrefs → `{% url 'name' %}`; every `<form>` gets `method`, `action
  {% url %}`, and **`{% csrf_token %}`**. Forms render from Django `Form`/`ModelForm` but
  keep the design's field markup/classes (use widget attrs or render fields manually).

## Backend craft (Django)

- **Layout**: `config/` (settings, urls, wsgi/asgi), one or more apps, `templates/`,
  `static/`, `manage.py`, `requirements.txt`, `.gitignore` (`.venv`, `db.sqlite3`,
  `__pycache__`, `.env`, `staticfiles`).
- **Settings, safely**: `SECRET_KEY` from env (`os.environ`), `DEBUG = os.environ.get(...)
  == "1"` (default off for prod, on for local), real `ALLOWED_HOSTS`. Never commit secrets.
- **Models** are the source of truth: clear fields, `__str__`, `Meta.ordering`,
  relationships; `makemigrations` + `migrate`; register in `admin.py`.
- **Views**: prefer class-based (`ListView`/`DetailView`/`CreateView`) or thin function
  views; pass real context; handle GET/POST; 404 with `get_object_or_404`.
- **URLs**: app `urls.py` with named patterns, included from `config/urls.py`.
- **Forms**: `ModelForm` with validation; show errors inline in the design's style; never
  trust input.
- **Auth** (if the design has login/signup): `django.contrib.auth`, `LoginView`/`LogoutView`,
  `@login_required`/`LoginRequiredMixin`, the design's auth pages as templates.
- **Security**: CSRF on every form, `DEBUG=False` in prod, no secrets in code, escape output
  (Django autoescapes — don't `|safe` user data), validate/whitelist.

## Frontend (keep the design, enhance it)

- HTML/CSS stay the design's — semantic, accessible (cross-ref `craft(accessibility)`),
  responsive. **Don't break the CSS** by changing classes.
- JS as **progressive enhancement**: the page works without it; JS adds interactivity (fetch
  to JSON endpoints, form UX, toggles). Vanilla or a small lib — match the design.
- If the app needs live data, add JSON views/endpoints and `fetch()` them; otherwise render
  server-side.

## Deliverable & run

- It must **boot**: `pip install -r requirements.txt`, `migrate`, `runserver` → the pages
  render with the design intact and the dynamic parts working.
- A short `README` with the run steps. Seed/sample data if it helps demo it.

## Self-check before finishing

- **No leftover server**: verify with `manage.py check` (and `makemigrations --check`). If you
  ever start `runserver` to look, **stop it** — never leave a dev server running in the
  background; it squats a port and breaks other apps.
- **It runs**: every page renders, `manage.py check` clean, migrations applied?
- **Design preserved**: same look, CSS intact, classes unchanged, responsive still works?
- **Real, not static**: lists/detail/forms backed by models; forms validate + CSRF?
- **Safe**: SECRET_KEY/DEBUG from env, no secrets committed, output escaped?
- **Templated, not duplicated**: one base, pages extend it, static via `{% static %}`?
- **Verified stepwise**: you ran it as you went, not just at the end?
