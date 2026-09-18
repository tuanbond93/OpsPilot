# HƯỚNG DẪN CUNG CẤP DỮ LIỆU NGUỒN QUY CHUẨN ĐỘI XE (LEVEL C — GATE 3C.2A)

Tài liệu này hướng dẫn Quy trình chuẩn hóa và cung cấp dữ liệu định mức xe, năng lực tải và khả dụng phương tiện cho hệ thống OpsPilot.

> **CẢNH BÁO QUAN TRỌNG:**
> 1. Các file CSV đính kèm (`vehicle_rates_template.csv`, `vehicle_classes_template.csv`, `vehicle_availability_template.csv`) chỉ chứa dòng tiêu đề (headers).
> 2. Tuyệt đối **KHÔNG** đưa dữ liệu giả lập (mock/dummy) vào môi trường Production.
> 3. Toàn bộ số liệu định mức và tải trọng phải có căn cứ chứng minh nguồn (`source_ref`, `contract_ref`). Hệ thống từ chối mọi số liệu không rõ nguồn gốc.
> 4. **PHÂN ĐỊNH RÕ HAI NHÓM DỮ LIỆU**:
>    - **GIAI ĐOẠN 1 (STATIC MASTER DATA - Yêu cầu Owner cung cấp)**: Bảng phân hạng xe (`governed_vehicle_classes`) và Biểu phí định mức (`governed_vehicle_rates`). Đây là dữ liệu chuẩn ít biến động.
>    - **GIAI ĐOẠN 2 (DYNAMIC OPERATIONAL TELEMETRY - Không yêu cầu Owner nhập tay liên tục)**: Bảng khả dụng xe (`vehicle_fleet_availability`). Dữ liệu này thuộc dạng đo đạc viễn thông / lệnh điều vận trực tiếp (`SOURCE_EXPECTATION: LIVE_SOURCE / AUTHORIZED_OPERATIONAL_FACT / MANUAL_EMERGENCY_ONLY`).
> 5. **DANH MỤC 3 KHO PILOT STAGE 1 CHUẨN HÓA**:
>    - `21161000`: Kho Giao Hàng Nặng - TP Yên Bái - Yên Bái
>    - `21158000`: Kho Giao Hàng Nặng - TP Lào Cai - Lào Cai
>    - `21160000`: Kho Giao Hàng Nặng - Việt Trì - Phú Thọ

---

## 1. File `vehicle_classes_template.csv` (STATIC MASTER DATA - Định mức dòng xe & tải trọng)

Mỗi dòng đại diện cho một phân hạng phương tiện chuẩn được phê duyệt trong hệ thống.

| Tên cột | Kiểu dữ liệu | Bắt buộc | Diễn giải chi tiết |
|---|---|---|---|
| `vehicle_class` | Chuỗi (TEXT) | **Bắt buộc** | Mã định danh phân hạng xe (VD: `TRUCK_1_25T`, `TRUCK_2_5T`, `TRUCK_5T`, `VAN_1T`). Khóa chính duy nhất. |
| `max_payload_kg` | Số (NUMERIC) | **Bắt buộc** | Tải trọng tối đa cho phép theo đăng kiểm/hợp đồng (kg), $\ge 0$. |
| `usable_payload_kg` | Số (NUMERIC) | Tùy chọn | Tải trọng vận hành hữu dụng thực tế sau khi trừ bao bì/pallet/hệ số đóng hàng (kg). Nếu để trống sẽ coi bằng `max_payload_kg`. |
| `volume_m3` | Số (NUMERIC) | Tùy chọn | Thể tích thùng xe khả dụng ($m^3$), $\ge 0$. |
| `effective_at` | Thời gian (ISO 8601) | **Bắt buộc** | Thời điểm bắt đầu có hiệu lực (VD: `2026-09-01T00:00:00+07:00`). |
| `source_ref` | Chuỗi (TEXT) | **Bắt buộc** | Mã số văn bản, quy chuẩn kỹ thuật hoặc quyết định ban hành thông số xe (VD: `QC-VAN-TAI-2026-Q3`). |

### Ví dụ minh họa (CHỈ ĐỂ THAM KHẢO, KHÔNG IMPORT VÀO PROD):
```csv
TRUCK_5T,5000,4800,24.5,2026-09-01T00:00:00+07:00,QC-DONG-XE-2026-01
TRUCK_2_5T,2500,2400,12.0,2026-09-01T00:00:00+07:00,QC-DONG-XE-2026-01
```

---

## 2. File `vehicle_rates_template.csv` (STATIC MASTER DATA - Biểu phí định mức xe can thiệp)

Mỗi dòng quy định đơn giá thuê hoặc điều động xe tăng cường theo từng kho/phạm vi.

| Tên cột | Kiểu dữ liệu | Bắt buộc | Diễn giải chi tiết |
|---|---|---|---|
| `warehouse_id` | Chuỗi (TEXT) | **Bắt buộc** | Mã kho áp dụng (`21161000`: Kho Giao Hàng Nặng - TP Yên Bái - Yên Bái, `21158000`: Kho Giao Hàng Nặng - TP Lào Cai - Lào Cai, `21160000`: Kho Giao Hàng Nặng - Việt Trì - Phú Thọ) hoặc `GLOBAL` nếu áp dụng toàn quốc. |
| `vehicle_class` | Chuỗi (TEXT) | **Bắt buộc** | Phân hạng xe (phải khớp với `vehicle_class` đã khai báo trong bảng `governed_vehicle_classes`). |
| `route_or_area` | Chuỗi (TEXT) | Tùy chọn | Tuyến đường hoặc cự ly áp dụng (VD: `NOI_TINH`, `LIEN_TINH_DUOI_100KM`, `TRUNG_CHUYEN`). Để trống nếu áp dụng chung. |
| `rate_vnd` | Số nguyên (BIGINT) | **Bắt buộc** | Chi phí định mức tính bằng VNĐ, $\ge 0$. |
| `rate_basis` | Chuỗi (ENUM) | **Bắt buộc** | Cơ sở tính giá: chấp nhận: `TRIP` (chuyến), `DAY` (ngày), `HOUR` (giờ), `KG` (theo kg), `MONTH` (theo tháng). Lưu ý: Biểu phí tháng giữ nguyên định mức `MONTH`, tuyệt đối không tự ý chia 30 sang ngày. |
| `effective_at` | Thời gian (ISO 8601) | **Bắt buộc** | Thời điểm biểu phí bắt đầu có hiệu lực. |
| `expires_at` | Thời gian (ISO 8601) | Tùy chọn | Thời điểm biểu phí hết hạn. Quá thời điểm này, hệ thống sẽ đánh dấu `STALE` và không sử dụng để ra quyết định. |
| `supplier_name` | Chuỗi (TEXT) | Tùy chọn | Tên đơn vị vận tải / đối tác cung cấp dịch vụ xe ngoài. |
| `contract_ref` | Chuỗi (TEXT) | Có điều kiện | Mã số hợp đồng nguyên tắc hoặc phụ lục hợp đồng vận tải. Bắt buộc khi `provenance_status = DOCUMENT_VERIFIED`. Được phép NULL khi `provenance_status = OWNER_CONFIRMED_PENDING_DOCUMENT` (số liệu do Owner xác nhận nhưng chưa đính kèm văn bản hợp đồng). |
| `source_ref` | Chuỗi (TEXT) | **Bắt buộc** | Mã quyết định phê duyệt, căn cứ phê duyệt hoặc mã xác nhận của Owner (VD: `OWNER_CONFIRMED:OPS_OWNER:2026-09-18`). |
| `provenance_status` | Chuỗi (ENUM) | **Bắt buộc** | Trạng thái chứng minh nguồn: `DOCUMENT_VERIFIED` (đã có hợp đồng/văn bản pháp lý) hoặc `OWNER_CONFIRMED_PENDING_DOCUMENT` (Owner xác nhận vận hành tạm thời, chưa có số hợp đồng). |

### Ví dụ minh họa (CHỈ ĐỂ THAM KHẢO, KHÔNG IMPORT VÀO PROD):
```csv
21160000,TRUCK_5T,NOI_TINH,1800000,TRIP,2026-09-01T00:00:00+07:00,2026-12-31T23:59:59+07:00,Cong ty Co phan Van tai Tay Bac,HD-VT-2026/PHUTHO,QD-BG-2026-09
21158000,TRUCK_2_5T,NOI_TINH,1200000,TRIP,2026-09-01T00:00:00+07:00,2026-12-31T23:59:59+07:00,Cong ty TNHH Van tai Hoang Lien,HD-VT-2026/LAOCAI,QD-BG-2026-09
```

---

## 3. File `vehicle_availability_template.csv` (DYNAMIC OPERATIONAL TELEMETRY - Không yêu cầu nhập tay hàng ngày)

Mỗi dòng phản ánh trạng thái sẵn sàng của phương tiện tại kho ở một thời điểm cụ thể.

> **ĐỊNH NGHĨA KỲ VỌNG NGUỒN (SOURCE EXPECTATION)**:
> - `SOURCE_EXPECTATION`: `LIVE_SOURCE` / `AUTHORIZED_OPERATIONAL_FACT` / `MANUAL_EMERGENCY_ONLY`.
> - Không yêu cầu Owner nhập liệu thủ công hàng ngày. Bảng này dự kiến kết nối API điều vận viễn thông hoặc ghi nhận fact điều vận được xác thực có TTL (`valid_until`).
> - Khi `now() > valid_until`: trạng thái tự động chuyển thành `UNKNOWN`.

| Tên cột | Kiểu dữ liệu | Bắt buộc | Diễn giải chi tiết |
|---|---|---|---|
| `warehouse_id` | Chuỗi (TEXT) | **Bắt buộc** | Mã kho có phương tiện hoạt động. |
| `vehicle_id` | Chuỗi (TEXT) | Tùy chọn | Biển số xe hoặc mã định danh xe cụ thể (VD: `29H-888.88`). |
| `vehicle_class` | Chuỗi (TEXT) | **Bắt buộc** | Phân hạng xe (phải khớp với bảng `governed_vehicle_classes`). |
| `available` | Boolean | **Bắt buộc** | `TRUE` nếu xe sẵn sàng điều động; `FALSE` nếu xe đã có lệnh chạy khác/bảo dưỡng. |
| `available_at` | Thời gian (ISO 8601) | Tùy chọn | Giờ xe có thể có mặt tại kho nhận hàng. |
| `remaining_capacity_kg` | Số (NUMERIC) | Tùy chọn | Tải trọng còn trống của chuyến xe nếu là xe ghép tải ($\ge 0$). |
| `captured_at` | Thời gian (ISO 8601) | **Bắt buộc** | Thời điểm ghi nhận trạng thái từ hệ thống điều vận hoặc tài xế. |
| `valid_until` | Thời gian (ISO 8601) | **Bắt buộc** | Thời hạn hiệu lực của thông tin khả dụng. Quá giờ này, hệ thống sẽ coi trạng thái là `UNKNOWN` (không được tự động duy trì). |
| `source_ref` | Chuỗi (TEXT) | **Bắt buộc** | Nguồn cấp thông tin (VD: `TMS_DISPATCH_API`, `TELEMATICS_GPS_01`, `XAC_NHAN_DIEU_PHOI_TELEGRAM`). |

### Ví dụ minh họa (CHỈ ĐỂ THAM KHẢO, KHÔNG IMPORT VÀO PROD):
```csv
21161000,21C-091.22,TRUCK_2_5T,true,2026-09-18T14:30:00+07:00,2400,2026-09-18T13:00:00+07:00,2026-09-18T16:00:00+07:00,TMS_FLEET_STATUS
```
