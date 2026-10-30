# rocket_client.DefaultApi

All URIs are relative to *https://build-the-arsenal-team-rocket.com/api/api-reference*

Method | HTTP request | Description
------------- | ------------- | -------------
[**feedback_list**](DefaultApi.md#feedback_list) | **POST** /feedback/list | 
[**health_check**](DefaultApi.md#health_check) | **POST** /healthCheck | 
[**is_admin**](DefaultApi.md#is_admin) | **POST** /isAdmin | 


# **feedback_list**
> List[FeedbackList200ResponseInner] feedback_list()

### Example

* Api Key Authentication (apiKey):

```python
import rocket_client
from rocket_client.models.feedback_list200_response_inner import FeedbackList200ResponseInner
from rocket_client.rest import ApiException
from pprint import pprint

# Defining the host is optional and defaults to https://build-the-arsenal-team-rocket.com/api/api-reference
# See configuration.py for a list of all supported configuration parameters.
configuration = rocket_client.Configuration(
    host = "https://build-the-arsenal-team-rocket.com/api/api-reference"
)

# The client must configure the authentication and authorization parameters
# in accordance with the API server security policy.
# Examples for each auth method are provided below, use the example that
# satisfies your auth use case.

# Configure API key authorization: apiKey
configuration.api_key['apiKey'] = os.environ["API_KEY"]

# Uncomment below to setup prefix (e.g. Bearer) for API key, if needed
# configuration.api_key_prefix['apiKey'] = 'Bearer'

# Enter a context with an instance of the API client
with rocket_client.ApiClient(configuration) as api_client:
    # Create an instance of the API class
    api_instance = rocket_client.DefaultApi(api_client)

    try:
        api_response = api_instance.feedback_list()
        print("The response of DefaultApi->feedback_list:\n")
        pprint(api_response)
    except Exception as e:
        print("Exception when calling DefaultApi->feedback_list: %s\n" % e)
```



### Parameters

This endpoint does not need any parameter.

### Return type

[**List[FeedbackList200ResponseInner]**](FeedbackList200ResponseInner.md)

### Authorization

[apiKey](../README.md#apiKey)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json

### HTTP response details

| Status code | Description | Response headers |
|-------------|-------------|------------------|
**200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **health_check**
> str health_check()

### Example

* Api Key Authentication (apiKey):

```python
import rocket_client
from rocket_client.rest import ApiException
from pprint import pprint

# Defining the host is optional and defaults to https://build-the-arsenal-team-rocket.com/api/api-reference
# See configuration.py for a list of all supported configuration parameters.
configuration = rocket_client.Configuration(
    host = "https://build-the-arsenal-team-rocket.com/api/api-reference"
)

# The client must configure the authentication and authorization parameters
# in accordance with the API server security policy.
# Examples for each auth method are provided below, use the example that
# satisfies your auth use case.

# Configure API key authorization: apiKey
configuration.api_key['apiKey'] = os.environ["API_KEY"]

# Uncomment below to setup prefix (e.g. Bearer) for API key, if needed
# configuration.api_key_prefix['apiKey'] = 'Bearer'

# Enter a context with an instance of the API client
with rocket_client.ApiClient(configuration) as api_client:
    # Create an instance of the API class
    api_instance = rocket_client.DefaultApi(api_client)

    try:
        api_response = api_instance.health_check()
        print("The response of DefaultApi->health_check:\n")
        pprint(api_response)
    except Exception as e:
        print("Exception when calling DefaultApi->health_check: %s\n" % e)
```



### Parameters

This endpoint does not need any parameter.

### Return type

**str**

### Authorization

[apiKey](../README.md#apiKey)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json

### HTTP response details

| Status code | Description | Response headers |
|-------------|-------------|------------------|
**200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **is_admin**
> bool is_admin()

### Example

* Api Key Authentication (apiKey):

```python
import rocket_client
from rocket_client.rest import ApiException
from pprint import pprint

# Defining the host is optional and defaults to https://build-the-arsenal-team-rocket.com/api/api-reference
# See configuration.py for a list of all supported configuration parameters.
configuration = rocket_client.Configuration(
    host = "https://build-the-arsenal-team-rocket.com/api/api-reference"
)

# The client must configure the authentication and authorization parameters
# in accordance with the API server security policy.
# Examples for each auth method are provided below, use the example that
# satisfies your auth use case.

# Configure API key authorization: apiKey
configuration.api_key['apiKey'] = os.environ["API_KEY"]

# Uncomment below to setup prefix (e.g. Bearer) for API key, if needed
# configuration.api_key_prefix['apiKey'] = 'Bearer'

# Enter a context with an instance of the API client
with rocket_client.ApiClient(configuration) as api_client:
    # Create an instance of the API class
    api_instance = rocket_client.DefaultApi(api_client)

    try:
        api_response = api_instance.is_admin()
        print("The response of DefaultApi->is_admin:\n")
        pprint(api_response)
    except Exception as e:
        print("Exception when calling DefaultApi->is_admin: %s\n" % e)
```



### Parameters

This endpoint does not need any parameter.

### Return type

**bool**

### Authorization

[apiKey](../README.md#apiKey)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json

### HTTP response details

| Status code | Description | Response headers |
|-------------|-------------|------------------|
**200** | OK |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

