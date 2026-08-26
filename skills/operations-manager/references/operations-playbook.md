# Operations Playbook

Phiên bản nghiệp vụ: `2026-08-25.5`. Engine tương ứng trong OpsPilot: `src/domain/operational-learning/root-cause-playbook.ts`.

## Khái niệm

- Đơn có hậu tố `_CPTT`: chứng từ thu hồi.
- Kho GHN: kho giao hàng nặng hoặc kho được định danh GHN trong metadata.
- KCT/KTC: kho chuyển tiếp hoặc trung chuyển.
- KHL/Key Account: kho khách hàng lớn.
- Các kho GHN có COT luân chuyển lúc 07:00 sáng.

## Rule hiện có

### `PICKUP_COMPLETION_DELAY`

Nếu thời gian từ lúc tạo đơn đến lúc hoàn tất lấy hàng vượt 24 giờ, ghi nhận lỗi chậm tại khâu lấy dù trạng thái hiện tại đã giao, trung chuyển hoặc hoàn tất. Quy trách nhiệm cho kho lấy trong hành trình và kiểm tra điểm nghẽn bàn giao sang tuyến tiếp theo.

### `CPTT_GHN_OUTBOUND_DELAY`

Đơn `_CPTT` lưu tại kho GHN từ 24 giờ trở lên trước khi xuất. Quy trách nhiệm chặng cho kho GHN đó. Action: kiểm tra vì sao chứng từ không được xuất ngay.

### `TRANSIT_TO_HUB_NOT_EXPORTED`

Đơn ở KCT đã qua COT 07:00 áp dụng mà chưa xuất, đích kế tiếp là kho trung chuyển lớn/hub. Nhập trước 07:00 thì áp dụng COT cùng ngày; nhập từ 07:00 trở đi thì áp dụng COT ngày kế tiếp. Quy trách nhiệm cho KCT hiện tại.

### `TRANSIT_TO_GHN_NOT_EXPORTED`

Đơn ở KCT đã qua COT 07:00 áp dụng mà chưa xuất, đích kế tiếp là kho GHN. Kho GHN đích là đầu mối action: làm việc lại với KCT, xác minh vì sao chưa nhận kiện sau COT và yêu cầu xuất sang kho GHN.

### `TRANSIT_WAREHOUSE_NOT_EXPORTED`

Chỉ dùng khi đơn ở KCT đã qua COT 07:00 áp dụng nhưng timeline chưa xác định được kho kế tiếp. Không quy action cuối cùng trước khi xác minh đích: sang hub thì KCT xử lý; sang kho GHN thì kho GHN làm việc với KCT.

### `KEY_ACCOUNT_WAREHOUSE_LONG_DWELL`

Đơn nằm tại kho KHL/Key Account ít nhất 24 giờ. Action: kiểm tra tình hình vận hành và nguyên nhân om hàng tại kho đó.

### `MORNING_COT_LATE_GHN_INTAKE`

Hàng rời KCT trước hoặc tại 07:00 nhưng đến kho GHN từ 12:00 trở đi, với thời gian di chuyển ít nhất 6 giờ. Action: kiểm tra kho GHN vì sao nhập hàng từ chuyến COT sáng muộn.

### `GHN_MISSED_0700_COT`

Đơn đã nhập kho GHN, đã qua COT 07:00 kế tiếp và vẫn chưa xuất. Action: kiểm tra vì sao chưa cho đi giao sau COT.

### `GHN_MORNING_INTAKE_NOT_ASSIGNED_DELIVERY`

Đơn nhập kho GHN trong buổi sáng, đến sau 13:00 cùng ngày và đã tồn ít nhất 2 giờ nhưng trạng thái vẫn là `storing`, chưa chuyển sang giao. Quy trách nhiệm cho kho GHN hiện tại. Action: kiểm tra vì sao hàng nhận từ KCT buổi sáng chưa được gán giao và xuất giao trong ngày.

### `FINAL_WAREHOUSE_LATE_DELIVERY_START`

Đơn đã đến kho giao cuối nhưng timestamp bắt đầu giao muộn hơn COT 07:00 áp dụng gần nhất. Giữ finding lịch sử kể cả khi đơn hiện đang giao hoặc đã giao thành công. Quy trách nhiệm cho kho giao cuối và kiểm tra vì sao chưa gán/xuất giao tại COT áp dụng.

Chưa có rule cho thời gian từ `deliveryStartedAt` đến `endSuccessAt`. Phải có SLA do Operations Manager xác nhận và quy tắc xử lý lần giao thất bại trước khi bổ sung.

## Gom nhóm

Khóa nhóm gồm:

```text
orderType | customerId | responsibleWarehouseIds | sortedFindingCodes
```

Không gom nếu khác khách hàng, khác loại `_CPTT`, khác kho chịu trách nhiệm hoặc khác tập lỗi.

## Playbook gap

Một case là gap khi có timeline hợp lệ nhưng không sinh finding. Báo tối thiểu: mã đơn, khách hàng, trạng thái, kho hiện tại, chuỗi kho, thời gian nhập/xuất. Chờ Operations Manager con người cung cấp root cause và action trước khi thêm rule cùng test hồi quy.
