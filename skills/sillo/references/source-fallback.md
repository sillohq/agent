# Checking the installed framework

Skills cover the common paths. When you need an argument, a return type or a behaviour
they do not show, get it from the Sillo the project actually runs — never from memory
and never from another framework that has a similar feature.

## Find it

```bash
# Where the installed framework lives (use the project's interpreter).
.venv/bin/python -c "import sillo, os; print(sillo.__version__, os.path.dirname(sillo.__file__))"

# Or without importing it:
.venv/bin/python -c "import importlib.util as u; print(u.find_spec('sillo').origin)"
```

The official packages are separate top-level modules: `sillo_inertia`, `sillo_oauth`,
`sillo_wire`, `sillo_graphql`, `warder`.

## Read it

```bash
# Exact signature and docstring of one API.
.venv/bin/python - <<'PY'
import inspect
from sillo.work.queue import Job
print(inspect.signature(Job.dispatch))
print(inspect.getdoc(Job.dispatch))
PY

# Everything a package exports.
.venv/bin/python -c "import sillo.cache as m; print(m.__all__)"

# Where a name is defined, then read that file.
grep -rn "def setup_mail" "$(dirname "$(.venv/bin/python -c 'import sillo; print(sillo.__file__)')")"
```

Sillo's docstrings are detailed and usually explain *why* an API behaves as it does;
read the docstring of the function you are calling, and of the class it belongs to.

## Ask the running application

```bash
sillo version          # installed version and which optional extras really import
sillo routes           # every registered route, with mounts expanded
sillo routes --method post
```

The `sillo` command imports the application (via `SILLO_APP`, `[tool.sillo] app`, or
`app.main:app` / `main:app` / `app:app`), so `db:*`, `user:*`, `queue:*` and
`schedule:*` only appear when the app's wiring puts a database manager or scheduler on
`app.state`.

## Rules

- Trust the installed source over any documentation, including these skills, when they
  disagree — and mention the disagreement to the user.
- Read; do not edit anything under `site-packages`.
- A name that exists in the source but not in its package's `__all__` is internal.
  Prefer the exported API.
