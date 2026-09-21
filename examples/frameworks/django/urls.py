from django.http import JsonResponse
from django.urls import include, path


def catalog(request):
    return JsonResponse({"items": [{"id": "book", "quantity": 2}]})


urlpatterns = [
    path(
        "api/",
        include(([path("catalog/", catalog, name="catalog")], "catalog")),
    )
]
