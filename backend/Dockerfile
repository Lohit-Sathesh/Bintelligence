FROM python:3.11-slim

# Non-root user (required by HuggingFace Spaces, good practice elsewhere)
RUN useradd -m -u 1000 user
WORKDIR /code

# Install deps first (layer cache — only re-runs when requirements change)
COPY app/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# App code + model
COPY app/ ./app/

# Frontend static files (served by FastAPI at /)
COPY webapp/ ./webapp/

USER user

# PORT defaults to 7860 (HuggingFace Spaces).
# Render/Fly inject their own $PORT automatically.
ENV PORT=7860
EXPOSE 7860

CMD uvicorn app.main:app --host 0.0.0.0 --port $PORT
