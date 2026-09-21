from app import app, catalog

app.add_api_route("/catalog", catalog, methods=["GET"])
