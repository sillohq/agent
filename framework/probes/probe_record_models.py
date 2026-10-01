"""A small schema exercising the Record features the skills teach."""

from sillo.record import Model
from sillo.record.events import HasEvents
from sillo.record.fields import SlugField
from tortoise import fields


class Author(Model):
    name = fields.CharField(max_length=100)

    class Meta:
        table = "authors"


class Tag(Model):
    name = fields.CharField(max_length=50, unique=True)

    class Meta:
        table = "tags"


class Post(Model, HasEvents):
    title = fields.CharField(max_length=200)
    slug = SlugField(source_field="title")
    status = fields.CharField(max_length=20, default="draft")
    views = fields.IntField(default=0)
    meta = fields.TextField(null=True)
    author = fields.ForeignKeyField("models.Author", related_name="posts")
    tags = fields.ManyToManyField("models.Tag", related_name="posts")

    _casts = {"meta": "json"}

    class Meta:
        table = "posts"

    @classmethod
    def scope_published(cls, queryset):
        return queryset.filter(status="published")

    @classmethod
    def scope_by_author(cls, queryset, author_id):
        return queryset.filter(author_id=author_id)


class Setting(Model):
    key = fields.CharField(max_length=50, unique=True)
    value = fields.CharField(max_length=200)

    class Meta:
        table = "settings"


__models__ = [Author, Tag, Post, Setting]
