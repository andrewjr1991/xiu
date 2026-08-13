FROM python:3.12-slim-bookworm

RUN groupadd --gid 10001 xiu \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin xiu
WORKDIR /app
COPY server.py /app/server.py
RUN mkdir /data && chown xiu:xiu /data

USER xiu
EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD python /app/server.py --self-test >/dev/null || exit 1

ENTRYPOINT ["python", "/app/server.py"]
