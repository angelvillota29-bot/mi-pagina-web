#!/bin/bash
set -e

# Los volúmenes se montan DESPUÉS de construir la imagen, así que el
# chown del Dockerfile no les llega. Lo hacemos aquí, en cada arranque
# del contenedor, cuando el volumen ya está disponible.
mkdir -p /var/www/html/data /var/www/html/uploads
chown -R www-data:www-data /var/www/html/data /var/www/html/uploads
chmod -R 775 /var/www/html/data /var/www/html/uploads

exec apache2-foreground
