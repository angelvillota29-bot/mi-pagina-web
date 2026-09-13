FROM php:8.2-apache
COPY . /var/www/html/
RUN mkdir -p /var/www/html/data /var/www/html/uploads
RUN chown -R www-data:www-data /var/www/html && chmod -R 775 /var/www/html
RUN chmod +x /var/www/html/entrypoint.sh
RUN a2enmod rewrite
EXPOSE 80
ENTRYPOINT ["/var/www/html/entrypoint.sh"]