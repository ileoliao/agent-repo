"""uvicorn harbor_platform.main:app"""

from .app import create_app

app = create_app()
