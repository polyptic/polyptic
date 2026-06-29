#!/bin/sh
# polyptych-agent — post-remove hook (deb postrm / rpm postun; one script for both).
#
# On a deb *purge*, drop the remaining config + state directories. Leave them in place on a plain
# remove or an upgrade so reinstalling keeps the box's enrolment credential + config.
#   deb postrm: $1 = remove | purge | upgrade | ...
#   rpm postun: $1 = 0 (final erase) | 1 (upgrade)   — rpm has no "purge" notion.
set -e

case "${1:-}" in
  purge)
    rm -rf /etc/polyptych
    rm -rf /var/lib/polyptych
    ;;
esac
exit 0
