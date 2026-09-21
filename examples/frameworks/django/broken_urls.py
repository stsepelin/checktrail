from urls import urlpatterns as original

urlpatterns = [*original, original[0]]
