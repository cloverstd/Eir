idf_component_register(SRCS "main.cpp" "ble.cpp" "scale.cpp" INCLUDE_DIRS "." REQUIRES bt nvs_flash esp_wifi esp_event esp_netif esp_http_server esp_http_client app_update esp_timer driver spiffs espressif__cjson espressif__mqtt mbedtls esp_driver_gpio)
target_compile_features(${COMPONENT_LIB} PUBLIC cxx_std_17)
