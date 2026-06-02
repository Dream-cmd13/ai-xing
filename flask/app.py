from flask import Flask, jsonify
from flask_cors import CORS

from config import Config
from routes.admin_users import admin_users_bp
from routes.ai import ai_bp


def create_app() -> Flask:
    Config.validate()
    app = Flask(__name__)
    app.config.from_object(Config)

    CORS(
        app,
        resources={r"/api/*": {"origins": Config.CORS_ALLOW_ORIGINS}},
        supports_credentials=False,
    )

    app.register_blueprint(ai_bp, url_prefix="/api/ai")
    app.register_blueprint(admin_users_bp, url_prefix="/api/admin")

    @app.get("/health")
    def health():
        return jsonify(
            {
                "success": True,
                "data": {
                    "status": "ok",
                    "service": "okr-ai-backend",
                    "backendTarget": "flask",
                },
            }
        )

    @app.errorhandler(ValueError)
    def handle_value_error(error: ValueError):
        return (
            jsonify(
                {
                    "success": False,
                    "error": {"code": "BAD_REQUEST", "message": str(error)},
                }
            ),
            400,
        )

    @app.errorhandler(PermissionError)
    def handle_permission_error(error: PermissionError):
        return (
            jsonify(
                {
                    "success": False,
                    "error": {"code": "FORBIDDEN", "message": str(error)},
                }
            ),
            403,
        )

    @app.errorhandler(RuntimeError)
    def handle_runtime_error(error: RuntimeError):
        return (
            jsonify(
                {
                    "success": False,
                    "error": {"code": "INTERNAL_ERROR", "message": str(error)},
                }
            ),
            500,
        )

    @app.errorhandler(Exception)
    def handle_unexpected_error(error: Exception):
        return (
            jsonify(
                {
                    "success": False,
                    "error": {
                        "code": "UNEXPECTED_ERROR",
                        "message": str(error) or "服务端发生未预期错误。",
                    },
                }
            ),
            500,
        )

    return app


app = create_app()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=Config.PORT, debug=Config.DEBUG)
