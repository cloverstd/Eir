package server

import (
	"eir/internal/afu"
	"eir/internal/store"
	"encoding/csv"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
)

var macPattern = regexp.MustCompile(`(?i)^[0-9a-f]{2}(:[0-9a-f]{2}){5}$`)

func (s *Server) deviceSettings(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ADCIndex *int `json:"adc_index"`
	}
	if !decode(w, r, &in) {
		return
	}
	if !store.UUIDPattern.MatchString(r.PathValue("id")) || (in.ADCIndex == nil || (*in.ADCIndex != 0 && *in.ADCIndex != 1)) {
		bad(w, "无效设备或 ADC 通道")
		return
	}
	t, e := s.Store.DB.Exec(r.Context(), "UPDATE devices SET adc_index=$2 WHERE id=$1 AND profile=$3", r.PathValue("id"), *in.ADCIndex, afu.Profile)
	if e != nil {
		fail(w, e)
		return
	}
	if t.RowsAffected() == 0 {
		http.NotFound(w, r)
		return
	}
	s.Changed()
	s.one(w, r, "SELECT * FROM devices WHERE id=$1", r.PathValue("id"))
}

func (s *Server) exportBody(w http.ResponseWriter, r *http.Request, where string, args []any) {
	rows, e := s.Store.DB.Query(r.Context(), "SELECT coalesce(member_name,''),device_name,coalesce(measured_at::text,''),time_source,weight_kg,body_fat_pct,body_fat_status,raw_adcs::text,adc_index,algorithm_version,notes,weight_valid FROM measurement_details WHERE "+where+" ORDER BY measured_at DESC NULLS LAST", args...)
	if e != nil {
		fail(w, e)
		return
	}
	defer rows.Close()
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="eir-body-composition.csv"`)
	fmt.Fprint(w, "\ufeff")
	c := csv.NewWriter(w)
	c.Write([]string{"成员", "设备", "采集时间", "时间来源", "体重(kg)", "估算体脂率(%)", "体脂状态", "原始ADC", "计算通道", "算法版本", "备注", "体重有效"})
	for rows.Next() {
		var member, device, at, source, status, adcs, version, notes string
		var weight, fat float64
		var index int
		var valid bool
		if e = rows.Scan(&member, &device, &at, &source, &weight, &fat, &status, &adcs, &index, &version, &notes, &valid); e != nil {
			return
		}
		fatText := ""
		if valid && status == "estimated" {
			fatText = strconv.FormatFloat(fat, 'f', 2, 64)
		}
		c.Write([]string{safeCell(member), safeCell(device), at, source, strconv.FormatFloat(weight, 'f', 2, 64), fatText, status, adcs, strconv.Itoa(index + 1), version, safeCell(notes), strconv.FormatBool(valid)})
	}
	c.Flush()
}
