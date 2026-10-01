"""A user model with permissions and API keys, plus the tables they need."""

from sillo.auth.apikey.mixins import ApiKeyUserMixin
from sillo.auth.apikey.models import ApiKey
from sillo.permissions import PermissionMixin
from sillo.permissions.models import Group, GroupPermission, Permission, UserGroup, UserPermission
from sillo.record.fields import PasswordField
from sillo.users import UserBaseModel, UserManager


class Account(PermissionMixin, UserBaseModel, ApiKeyUserMixin):
    objects = UserManager()
    password = PasswordField()

    class Meta:
        table = "accounts"


Account.objects.contribute_to_class(Account, "objects")

__models__ = [Account, ApiKey, Permission, Group, UserPermission, UserGroup, GroupPermission]
