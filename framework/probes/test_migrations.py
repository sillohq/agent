"""The `sillo db:*` workflow, run for real against a throwaway project."""

import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

pytest.importorskip("tortoise")


def _project(root: Path, product_fields: str) -> None:
    (root / "app").mkdir(parents=True, exist_ok=True)
    (root / "database" / "models").mkdir(parents=True, exist_ok=True)
    (root / "storage").mkdir(exist_ok=True)
    (root / "pyproject.toml").write_text(
        '[project]\nname = "probe"\nversion = "0"\n\n[tool.sillo]\napp = "app.main:app"\n'
    )
    (root / "app" / "__init__.py").write_text("")
    (root / "database" / "__init__.py").write_text("")
    (root / "database" / "models" / "__init__.py").write_text(
        "from database.models.product import Product\n\n__models__ = [Product]\n"
    )
    (root / "database" / "models" / "product.py").write_text(
        "from sillo.record import Model\nfrom tortoise import fields\n\n\n"
        "class Product(Model):\n"
        "    name = fields.CharField(max_length=100)\n"
        + textwrap.indent(textwrap.dedent(product_fields), "    ")
        + '\n    class Meta:\n        table = "products"\n'
    )
    (root / "app" / "main.py").write_text(
        "from sillo import SilloApp\n"
        "from sillo.record import DatabaseConfig, setup_record\n\n"
        "app = SilloApp()\n"
        'setup_record(app, DatabaseConfig(url="sqlite://storage/app.db", generate_schemas=False),'
        ' model_modules=["database.models"])\n'
    )


def _sillo(root: Path, *args: str) -> subprocess.CompletedProcess:
    env = {**os.environ, "SILLO_ENV_FILE": "", "PYTHONPATH": str(root)}
    return subprocess.run(
        [sys.executable, "-m", "sillo", *args],
        cwd=root,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )


def test_db_commands_appear_and_migrate_round_trip(tmp_path):
    _project(tmp_path, "")
    listing = _sillo(tmp_path, "--help").stdout
    assert "db:migrate" in listing and "user:create" in listing

    assert _sillo(tmp_path, "db:init").returncode == 0
    made = _sillo(tmp_path, "db:make", "create_products")
    assert made.returncode == 0 and "0001_create_products" in made.stdout
    assert "No model changes" in _sillo(tmp_path, "db:make").stdout

    applied = _sillo(tmp_path, "db:migrate")
    assert applied.returncode == 0 and "Applied 1 migration" in applied.stdout
    assert "Up to date" in _sillo(tmp_path, "db:status").stdout

    _project(tmp_path, "price = fields.IntField(default=0)\n")
    assert _sillo(tmp_path, "db:make", "add_price").returncode == 0
    sql = _sillo(tmp_path, "db:sql", "0002_add_price").stdout
    assert 'ADD COLUMN "price"' in sql
    assert _sillo(tmp_path, "db:migrate").returncode == 0
    back = _sillo(tmp_path, "db:rollback", "0001_create_products", "--force")
    assert back.returncode == 0 and "Rolled back" in back.stdout


def test_semicolon_in_field_comment_breaks_migrate(tmp_path):
    _project(tmp_path, "")
    _sillo(tmp_path, "db:init")
    _sillo(tmp_path, "db:make", "create_products")
    _sillo(tmp_path, "db:migrate")
    _project(tmp_path, "#: Price in cents; never negative\nprice = fields.IntField(default=0)\n")
    _sillo(tmp_path, "db:make", "add_price")
    result = _sillo(tmp_path, "db:migrate")
    assert result.returncode != 0
    assert "incomplete input" in (result.stdout + result.stderr)


def test_custom_commands_need_context_for_the_database(tmp_path):
    _project(tmp_path, "")
    (tmp_path / "app" / "main.py").write_text(
        "from sillo import SilloApp\n"
        "from sillo.console import Command\n"
        "from sillo.record import DatabaseConfig, setup_record\n\n"
        "app = SilloApp()\n"
        'db = setup_record(app, DatabaseConfig(url="sqlite://storage/app.db", generate_schemas=True),'
        ' model_modules=["database.models"])\n\n\n'
        "class Plain(Command):\n"
        '    name = "products:plain"\n'
        "    async def handle(self):\n"
        "        from database.models import Product\n"
        "        self.success(str(await Product.all().count()))\n\n\n"
        "class WithContext(Plain):\n"
        '    name = "products:ctx"\n'
        "    def context(self):\n"
        "        return db\n\n\n"
        "app.add_command(Plain)\n"
        "app.add_command(WithContext)\n\n\n"
        '@app.command("hello", help="Say hello")\n'
        "async def hello(cmd):\n"
        '    cmd.success("hello")\n'
    )
    assert "default_connection" in (_sillo(tmp_path, "products:plain").stdout + _sillo(tmp_path, "products:plain").stderr)
    assert "0" in _sillo(tmp_path, "products:ctx").stdout
    assert "hello" in _sillo(tmp_path, "hello").stdout
