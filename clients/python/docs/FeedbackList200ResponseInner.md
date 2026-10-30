# FeedbackList200ResponseInner


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**id** | **str** |  | 
**text** | **str** |  | 
**created_at** | **datetime** |  | 
**name** | **str** |  | 
**email** | **str** |  | 

## Example

```python
from rocket_client.models.feedback_list200_response_inner import FeedbackList200ResponseInner

# TODO update the JSON string below
json = "{}"
# create an instance of FeedbackList200ResponseInner from a JSON string
feedback_list200_response_inner_instance = FeedbackList200ResponseInner.from_json(json)
# print the JSON string representation of the object
print(FeedbackList200ResponseInner.to_json())

# convert the object into a dict
feedback_list200_response_inner_dict = feedback_list200_response_inner_instance.to_dict()
# create an instance of FeedbackList200ResponseInner from a dict
feedback_list200_response_inner_from_dict = FeedbackList200ResponseInner.from_dict(feedback_list200_response_inner_dict)
```
[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)


