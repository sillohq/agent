"""The user model every Sillo 1.x project writes, as sillohq/starter writes it."""

from sillo.record.fields import PasswordField
from sillo.users import UserBaseModel, UserManager
from tortoise import fields


class User(UserBaseModel):
    objects = UserManager()
    password = PasswordField()
    full_name = fields.CharField(max_length=150, null=True)

    class Meta:
        table = "users"


User.objects.contribute_to_class(User, "objects")

__models__ = [User]
